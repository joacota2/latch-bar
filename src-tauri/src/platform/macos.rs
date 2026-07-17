use super::{NativeSelection, PlatformAdapter, PlatformStatus, ReplacementResult, SelectionBounds};
use core_foundation::{
    base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType},
    boolean::CFBoolean,
    dictionary::CFDictionary,
    string::{CFString, CFStringRef},
};
use core_graphics::{
    event::{CGEvent, CGEventFlags, KeyCode},
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::CGRect,
};
use std::{ffi::c_void, ptr, sync::Mutex, time::Duration};

type AXUIElementRef = *const c_void;

#[repr(C)]
struct CFRange {
    location: isize,
    length: isize,
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    static kAXTrustedCheckOptionPrompt: CFStringRef;
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef)
        -> bool;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementCopyParameterizedAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        parameter: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> i32;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> i32;
    fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut bool,
    ) -> i32;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
    fn AXValueGetValue(value: CFTypeRef, value_type: u32, output: *mut c_void) -> bool;
}

struct SelectionTarget {
    element: AXUIElementRef,
    process_id: i32,
}

unsafe impl Send for SelectionTarget {}

impl Drop for SelectionTarget {
    fn drop(&mut self) {
        unsafe { CFRelease(self.element as CFTypeRef) }
    }
}

#[derive(Default)]
pub struct MacOsAdapter {
    target: Mutex<Option<SelectionTarget>>,
    fallback_bounds: Mutex<Option<(i32, String, SelectionBounds)>>,
    last_selection: Mutex<Option<NativeSelection>>,
}

fn attribute(name: &str) -> CFString {
    CFString::new(name)
}

unsafe fn copied_value(element: AXUIElementRef, name: &str) -> Option<CFTypeRef> {
    let name = attribute(name);
    let mut value: CFTypeRef = ptr::null();
    (AXUIElementCopyAttributeValue(element, name.as_concrete_TypeRef(), &mut value) == 0
        && !value.is_null())
    .then_some(value)
}

unsafe fn copied_string(element: AXUIElementRef, name: &str) -> Option<String> {
    let value = copied_value(element, name)?;
    if CFGetTypeID(value) != CFString::type_id() {
        CFRelease(value);
        return None;
    }
    Some(CFString::wrap_under_create_rule(value as CFStringRef).to_string())
}

unsafe fn copied_range(element: AXUIElementRef, name: &str) -> Option<CFRange> {
    let value = copied_value(element, name)?;
    let mut range = CFRange {
        location: 0,
        length: 0,
    };
    let decoded = AXValueGetValue(value, 4, &mut range as *mut _ as *mut c_void);
    CFRelease(value);
    (decoded && range.location >= 0 && range.length > 0).then_some(range)
}

unsafe fn selected_text(element: AXUIElementRef) -> Option<String> {
    if let Some(text) = copied_string(element, "AXSelectedText").filter(|value| !value.is_empty()) {
        return Some(text);
    }

    // Chromium-backed controls can represent document selections with opaque text
    // markers instead of the CFRange attributes used by native editable controls.
    if let Some(range) = copied_value(element, "AXSelectedTextMarkerRange") {
        let name = attribute("AXStringForTextMarkerRange");
        let mut raw_text: CFTypeRef = ptr::null();
        let result = AXUIElementCopyParameterizedAttributeValue(
            element,
            name.as_concrete_TypeRef(),
            range,
            &mut raw_text,
        );
        CFRelease(range);
        if !raw_text.is_null() {
            if result == 0 && CFGetTypeID(raw_text) == CFString::type_id() {
                let text = CFString::wrap_under_create_rule(raw_text as CFStringRef).to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            } else {
                CFRelease(raw_text);
            }
        }
    }

    // A few native controls provide the selected range and complete value but omit
    // AXSelectedText. AX ranges use UTF-16 character offsets, so slice encoded units.
    let range = copied_range(element, "AXSelectedTextRange")?;
    let value = copied_string(element, "AXValue")?;
    let units = value.encode_utf16().collect::<Vec<_>>();
    let start = usize::try_from(range.location).ok()?;
    let length = usize::try_from(range.length).ok()?;
    let end = start.checked_add(length)?;
    (end <= units.len())
        .then(|| String::from_utf16_lossy(&units[start..end]))
        .filter(|value| !value.is_empty())
}

unsafe fn selected_element(mut element: AXUIElementRef) -> Option<(AXUIElementRef, String)> {
    // Browsers and custom controls often keep keyboard focus on a descendant while
    // exposing the selection on a text/web-area ancestor.
    for _ in 0..32 {
        let subrole = copied_string(element, "AXSubrole").unwrap_or_default();
        if subrole == "AXSecureTextField" {
            CFRelease(element as CFTypeRef);
            return None;
        }
        if let Some(text) = selected_text(element) {
            return Some((element, text));
        }
        let parent = copied_value(element, "AXParent").map(|value| value as AXUIElementRef);
        CFRelease(element as CFTypeRef);
        element = parent?;
    }
    CFRelease(element as CFTypeRef);
    None
}

unsafe fn selection_targets() -> Option<(Vec<AXUIElementRef>, i32)> {
    let system = AXUIElementCreateSystemWide();
    if system.is_null() {
        return None;
    }

    // AXFocusedApplication is not consistently exposed by the system-wide element,
    // especially while an Electron accessibility tree is still dormant. NSWorkspace
    // reliably identifies the real frontmost process so we can opt it in first.
    let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
    let running_application = workspace.frontmostApplication();
    let mut process_id = running_application
        .as_ref()
        .map(|application| application.processIdentifier())
        .unwrap_or_default();
    let application = (process_id > 0)
        .then(|| AXUIElementCreateApplication(process_id))
        .filter(|application| !application.is_null())
        .or_else(|| {
            copied_value(system, "AXFocusedApplication").map(|value| value as AXUIElementRef)
        });
    // Chromium/Electron applications keep their full accessibility tree dormant until
    // an assistive client opts in. This is the documented third-party switch used by
    // Electron and is harmless for native applications that do not implement it.
    if let Some(application) = application {
        let manual_accessibility = attribute("AXManualAccessibility");
        let enabled = CFBoolean::true_value();
        let _ = AXUIElementSetAttributeValue(
            application,
            manual_accessibility.as_concrete_TypeRef(),
            enabled.as_CFTypeRef(),
        );
    }
    let focused = application
        .and_then(|application| copied_value(application, "AXFocusedUIElement"))
        .or_else(|| copied_value(system, "AXFocusedUIElement"));

    // Some apps expose no AXFocusedUIElement at all (and web apps may leave focus in
    // a composer while the user selects message text elsewhere). macOS hit-testing
    // still exposes the element at the selection endpoint, so query the pointer too.
    let hit_tested = cursor_bounds().and_then(|bounds| {
        let mut element: AXUIElementRef = ptr::null();
        let result = AXUIElementCopyElementAtPosition(
            system,
            bounds.x as f32,
            bounds.y as f32,
            &mut element,
        );
        if result != 0 || element.is_null() {
            return None;
        }
        let mut element_pid = 0;
        if AXUIElementGetPid(element, &mut element_pid) != 0
            || (process_id > 0 && element_pid != process_id)
        {
            CFRelease(element as CFTypeRef);
            return None;
        }
        if process_id == 0 {
            process_id = element_pid;
        }
        Some(element)
    });

    if let Some(application) = application {
        if process_id == 0 {
            let _ = AXUIElementGetPid(application, &mut process_id);
        }
        CFRelease(application as CFTypeRef);
    }
    CFRelease(system as CFTypeRef);

    let mut targets = Vec::with_capacity(2);
    if let Some(focused) = focused {
        targets.push(focused as AXUIElementRef);
    }
    if let Some(hit_tested) = hit_tested {
        targets.push(hit_tested);
    }
    (!targets.is_empty() && process_id > 0).then_some((targets, process_id))
}

unsafe fn process_name(pid: i32) -> String {
    let application = AXUIElementCreateApplication(pid);
    if application.is_null() {
        return format!("Process {pid}");
    }
    let title = copied_string(application, "AXTitle").unwrap_or_else(|| format!("Process {pid}"));
    CFRelease(application as CFTypeRef);
    title
}

unsafe fn window_title(element: AXUIElementRef) -> Option<String> {
    let window = copied_value(element, "AXWindow")?;
    let title = copied_string(window as AXUIElementRef, "AXTitle");
    CFRelease(window);
    title
}

unsafe fn selection_bounds(element: AXUIElementRef) -> Option<SelectionBounds> {
    let range = copied_value(element, "AXSelectedTextRange")?;
    let mut decoded_range = CFRange {
        location: 0,
        length: 0,
    };
    if !AXValueGetValue(range, 4, &mut decoded_range as *mut _ as *mut c_void)
        || decoded_range.length <= 0
    {
        CFRelease(range);
        return None;
    }

    let name = attribute("AXBoundsForRange");
    let mut raw_bounds: CFTypeRef = ptr::null();
    let result = AXUIElementCopyParameterizedAttributeValue(
        element,
        name.as_concrete_TypeRef(),
        range,
        &mut raw_bounds,
    );
    CFRelease(range);
    if result != 0 || raw_bounds.is_null() {
        return None;
    }

    let mut bounds = CGRect::new(
        &core_graphics::geometry::CGPoint::new(0.0, 0.0),
        &core_graphics::geometry::CGSize::new(0.0, 0.0),
    );
    let decoded = AXValueGetValue(raw_bounds, 3, &mut bounds as *mut _ as *mut c_void);
    CFRelease(raw_bounds);
    (decoded
        && bounds.origin.x.is_finite()
        && bounds.origin.y.is_finite()
        && bounds.size.width.is_finite()
        && bounds.size.height.is_finite()
        && bounds.size.width > 0.0
        && bounds.size.height > 0.0)
        .then_some(SelectionBounds {
            x: bounds.origin.x,
            y: bounds.origin.y,
            width: bounds.size.width,
            height: bounds.size.height,
        })
}

fn cursor_bounds() -> Option<SelectionBounds> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let point = CGEvent::new(source).ok()?.location();
    Some(SelectionBounds {
        x: point.x,
        y: point.y,
        width: 1.0,
        height: 18.0,
    })
}

impl MacOsAdapter {
    fn paste_to_target(&self, text: &str, process_id: i32) -> Result<ReplacementResult, String> {
        self.copy_text(text)?;
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "Could not create a keyboard event source")?;
        let down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true)
            .map_err(|_| "Could not create the paste key-down event")?;
        let up = CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, false)
            .map_err(|_| "Could not create the paste key-up event")?;
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post_to_pid(process_id);
        std::thread::sleep(Duration::from_millis(20));
        up.post_to_pid(process_id);
        Ok(ReplacementResult {
            method: "clipboard-paste",
        })
    }
}

impl PlatformAdapter for MacOsAdapter {
    fn status(&self, prompt: bool) -> PlatformStatus {
        let trusted = unsafe {
            if prompt {
                let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
                let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
                AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
            } else {
                AXIsProcessTrusted()
            }
        };
        PlatformStatus {
            platform: "macos",
            supported: true,
            accessibility_trusted: trusted,
            permission_required: (!trusted).then_some("accessibility"),
            implementation: "axuielement",
            monitor_running: false,
            context_bar_ready: false,
        }
    }

    fn capture_selection(&self) -> Result<Option<NativeSelection>, String> {
        if !unsafe { AXIsProcessTrusted() } {
            return Ok(None);
        }
        unsafe {
            let Some((targets, process_id)) = selection_targets() else {
                return Ok(None);
            };
            if process_id == std::process::id() as i32 {
                for target in targets {
                    CFRelease(target as CFTypeRef);
                }
                return self
                    .last_selection
                    .lock()
                    .map(|selection| selection.clone())
                    .map_err(|_| "Last selection state is unavailable".into());
            }
            let mut targets = targets.into_iter();
            let mut selected = None;
            while let Some(target) = targets.next() {
                if let Some(selection) = selected_element(target) {
                    selected = Some(selection);
                    for unused in targets {
                        CFRelease(unused as CFTypeRef);
                    }
                    break;
                }
            }
            let Some((focused, text)) = selected else {
                if let Ok(mut cached) = self.fallback_bounds.lock() {
                    *cached = None;
                }
                if let Ok(mut selection) = self.last_selection.lock() {
                    *selection = None;
                }
                return Ok(None);
            };
            // Some WebKit/Electron controls expose AXSelectedText but not AXBoundsForRange.
            // Cache the pointer fallback for this selection so clicking the Context Bar does
            // not make the unchanged selection look new just because the pointer moved.
            let bounds = if let Some(bounds) = selection_bounds(focused) {
                if let Ok(mut cached) = self.fallback_bounds.lock() {
                    *cached = None;
                }
                bounds
            } else {
                let mut cached = self
                    .fallback_bounds
                    .lock()
                    .map_err(|_| "Selection bounds cache is unavailable")?;
                if let Some((cached_process, cached_text, cached_bounds)) = cached.as_ref() {
                    if *cached_process == process_id && cached_text == &text {
                        cached_bounds.clone()
                    } else {
                        let bounds = cursor_bounds().unwrap_or(SelectionBounds {
                            x: 8.0,
                            y: 8.0,
                            width: 1.0,
                            height: 18.0,
                        });
                        *cached = Some((process_id, text.clone(), bounds.clone()));
                        bounds
                    }
                } else {
                    let bounds = cursor_bounds().unwrap_or(SelectionBounds {
                        x: 8.0,
                        y: 8.0,
                        width: 1.0,
                        height: 18.0,
                    });
                    *cached = Some((process_id, text.clone(), bounds.clone()));
                    bounds
                }
            };
            let application = process_name(process_id);
            let title = window_title(focused);
            *self
                .target
                .lock()
                .map_err(|_| "Selection target is unavailable")? = Some(SelectionTarget {
                element: focused,
                process_id,
            });
            let selection = NativeSelection {
                text,
                application,
                window_title: title,
                process_id,
                bounds,
            };
            *self
                .last_selection
                .lock()
                .map_err(|_| "Last selection state is unavailable")? = Some(selection.clone());
            Ok(Some(selection))
        }
    }

    fn replace_selection(&self, text: &str) -> Result<ReplacementResult, String> {
        let target = self
            .target
            .lock()
            .map_err(|_| "Selection target is unavailable")?;
        let target = target
            .as_ref()
            .ok_or("The original selection is no longer available")?;
        let replacement = CFString::new(text);
        let selected_text = attribute("AXSelectedText");
        let mut settable = false;
        let can_set = unsafe {
            AXUIElementIsAttributeSettable(
                target.element,
                selected_text.as_concrete_TypeRef(),
                &mut settable,
            ) == 0
                && settable
        };
        let replaced = can_set
            && unsafe {
                AXUIElementSetAttributeValue(
                    target.element,
                    selected_text.as_concrete_TypeRef(),
                    replacement.as_CFTypeRef(),
                ) == 0
            };
        if replaced {
            Ok(ReplacementResult {
                method: "accessibility",
            })
        } else {
            self.paste_to_target(text, target.process_id)
        }
    }

    fn copy_text(&self, text: &str) -> Result<(), String> {
        let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
        clipboard.set_text(text).map_err(|error| error.to_string())
    }
}
