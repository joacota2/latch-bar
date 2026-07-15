use super::{NativeSelection, PlatformAdapter, PlatformStatus, ReplacementResult, SelectionBounds};
use core_foundation::{
    base::{CFRelease, CFTypeRef, TCFType},
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
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
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
    Some(CFString::wrap_under_create_rule(value as CFStringRef).to_string())
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
    decoded.then_some(SelectionBounds {
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
        }
    }

    fn capture_selection(&self) -> Result<Option<NativeSelection>, String> {
        if !unsafe { AXIsProcessTrusted() } {
            return Ok(None);
        }
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return Ok(None);
            }
            let focused = copied_value(system, "AXFocusedUIElement");
            CFRelease(system as CFTypeRef);
            let Some(focused) = focused else {
                return Ok(None);
            };
            let focused = focused as AXUIElementRef;

            let subrole = copied_string(focused, "AXSubrole").unwrap_or_default();
            if subrole == "AXSecureTextField" {
                CFRelease(focused as CFTypeRef);
                return Ok(None);
            }
            let Some(text) =
                copied_string(focused, "AXSelectedText").filter(|value| !value.is_empty())
            else {
                CFRelease(focused as CFTypeRef);
                return Ok(None);
            };
            // Some WebKit/Electron controls expose AXSelectedText but not AXBoundsForRange.
            // The cursor is a reliable placement fallback and keeps the native feature usable.
            let bounds =
                selection_bounds(focused)
                    .or_else(cursor_bounds)
                    .unwrap_or(SelectionBounds {
                        x: 8.0,
                        y: 8.0,
                        width: 1.0,
                        height: 18.0,
                    });
            let mut process_id = 0;
            if AXUIElementGetPid(focused, &mut process_id) != 0
                || process_id == std::process::id() as i32
            {
                CFRelease(focused as CFTypeRef);
                return Ok(None);
            }
            let application = process_name(process_id);
            let title = window_title(focused);
            *self
                .target
                .lock()
                .map_err(|_| "Selection target is unavailable")? = Some(SelectionTarget {
                element: focused,
                process_id,
            });
            Ok(Some(NativeSelection {
                text,
                application,
                window_title: title,
                process_id,
                bounds,
            }))
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
        let result = unsafe {
            AXUIElementSetAttributeValue(
                target.element,
                attribute("AXSelectedText").as_concrete_TypeRef(),
                replacement.as_CFTypeRef(),
            )
        };
        if result == 0 {
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
