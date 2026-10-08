use super::{
    NativeSelection, PlatformAdapter, PlatformStatus, ReplacementCapability, ReplacementResult,
    SelectionBounds,
};
use core_foundation::{
    base::{CFEqual, CFGetTypeID, CFRelease, CFRetain, CFTypeID, CFTypeRef, TCFType},
    boolean::{CFBoolean, CFBooleanRef},
    dictionary::CFDictionary,
    runloop::CFRunLoop,
    string::{CFString, CFStringRef},
};
use core_graphics::{
    event::{
        CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
        CGEventTapPlacement, CGEventType, CallbackResult, EventField, KeyCode,
    },
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::CGRect,
};
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSData, NSString};
use std::{
    ffi::c_void,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

const GESTURE_FRESHNESS: Duration = Duration::from_millis(1_500);
const FALLBACK_CACHE_LIFETIME: Duration = Duration::from_secs(300);
const COPY_TIMEOUT: Duration = Duration::from_millis(450);
const CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(10);
const REPLACEMENT_VERIFY_TIMEOUT: Duration = Duration::from_millis(500);
const REPLACEMENT_VERIFY_INTERVAL: Duration = Duration::from_millis(20);
const MAX_CLIPBOARD_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
const MINIMUM_DRAG_DISTANCE_SQUARED: f64 = 16.0;

static KEYBOARD_EVENTS_OBSERVED: AtomicBool = AtomicBool::new(false);

type SelectionCandidates = (Vec<AXUIElementRef>, i32, Option<usize>, Option<usize>);
type AXUIElementRef = *const c_void;

struct OwnedAxElement(AXUIElementRef);

impl OwnedAxElement {
    fn into_raw(self) -> AXUIElementRef {
        let element = self.0;
        std::mem::forget(self);
        element
    }
}

impl Drop for OwnedAxElement {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    fn AXValueGetTypeID() -> CFTypeID;
    fn AXValueGetValue(value: CFTypeRef, value_type: u32, output: *mut c_void) -> bool;
}

struct SelectionTarget {
    selection_id: String,
    range: Option<CFRange>,
    generation: u64,
    selection_element: Option<AXUIElementRef>,
    paste_element: Option<AXUIElementRef>,
    process_id: i32,
    selected_text: String,
    replacement_capability: ReplacementCapability,
}

unsafe impl Send for SelectionTarget {}

impl Drop for SelectionTarget {
    fn drop(&mut self) {
        if let Some(element) = self.selection_element {
            unsafe { CFRelease(element as CFTypeRef) }
        }
        if let Some(element) = self.paste_element {
            unsafe { CFRelease(element as CFTypeRef) }
        }
    }
}

pub struct MacOsAdapter {
    target: Mutex<Option<SelectionTarget>>,
    fallback_bounds: Mutex<Option<(i32, String, SelectionBounds)>>,
    last_selection: Mutex<Option<NativeSelection>>,
    fallback_selection: Mutex<Option<CachedFallbackSelection>>,
    gesture_state: Arc<Mutex<GestureState>>,
    processed_interaction: Mutex<u64>,
    gesture_monitor_started: AtomicBool,
}

impl Default for MacOsAdapter {
    fn default() -> Self {
        Self {
            target: Mutex::new(None),
            fallback_bounds: Mutex::new(None),
            last_selection: Mutex::new(None),
            fallback_selection: Mutex::new(None),
            gesture_state: Arc::new(Mutex::new(GestureState::default())),
            processed_interaction: Mutex::new(0),
            gesture_monitor_started: AtomicBool::new(false),
        }
    }
}

#[derive(Clone)]
struct CachedFallbackSelection {
    selection: NativeSelection,
    captured_at: Instant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InteractionKind {
    SelectionCandidate,
    ClearSelection,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InteractionOrigin {
    Pointer,
    Keyboard,
}

#[derive(Clone)]
struct SelectionInteraction {
    generation: u64,
    occurred_at: Instant,
    process_id: i32,
    bounds: SelectionBounds,
    kind: InteractionKind,
    origin: InteractionOrigin,
}

#[derive(Clone, Copy)]
struct MouseDown {
    x: f64,
    y: f64,
    process_id: i32,
}

#[derive(Default)]
struct GestureState {
    generation: u64,
    mouse_down: Option<MouseDown>,
    mouse_dragged: bool,
    latest: Option<SelectionInteraction>,
}

impl GestureState {
    fn record(
        &mut self,
        kind: InteractionKind,
        origin: InteractionOrigin,
        process_id: i32,
        bounds: SelectionBounds,
    ) {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.latest = Some(SelectionInteraction {
            generation: self.generation,
            occurred_at: Instant::now(),
            process_id,
            bounds,
            kind,
            origin,
        });
    }
}

#[derive(Clone)]
struct ClipboardEntry {
    data_type: String,
    data: Vec<u8>,
}

struct ClipboardSnapshot {
    change_count: isize,
    items: Vec<Vec<ClipboardEntry>>,
}

fn attribute(name: &str) -> CFString {
    CFString::new(name)
}

unsafe fn copied_value(element: AXUIElementRef, name: &str) -> Option<CFTypeRef> {
    let name = attribute(name);
    let mut value: CFTypeRef = ptr::null();
    if AXUIElementCopyAttributeValue(element, name.as_concrete_TypeRef(), &mut value) == 0
        && !value.is_null()
    {
        Some(value)
    } else {
        if !value.is_null() {
            CFRelease(value);
        }
        None
    }
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
    if CFGetTypeID(value) != AXValueGetTypeID() {
        CFRelease(value);
        return None;
    }
    let mut range = CFRange {
        location: 0,
        length: 0,
    };
    let decoded = AXValueGetValue(value, 4, &mut range as *mut _ as *mut c_void);
    CFRelease(value);
    (decoded && range.location >= 0 && range.length > 0).then_some(range)
}

unsafe fn copied_boolean(element: AXUIElementRef, name: &str) -> Option<bool> {
    let value = copied_value(element, name)?;
    if CFGetTypeID(value) != CFBoolean::type_id() {
        CFRelease(value);
        return None;
    }
    Some(bool::from(CFBoolean::wrap_under_create_rule(
        value as CFBooleanRef,
    )))
}

unsafe fn attribute_is_settable(element: AXUIElementRef, name: &str) -> bool {
    let name = attribute(name);
    let mut settable = false;
    AXUIElementIsAttributeSettable(element, name.as_concrete_TypeRef(), &mut settable) == 0
        && settable
}

unsafe fn confidently_editable_target(element: AXUIElementRef) -> Option<OwnedAxElement> {
    let mut current = OwnedAxElement(CFRetain(element as CFTypeRef) as AXUIElementRef);

    for _ in 0..32 {
        let subrole = copied_string(current.0, "AXSubrole").unwrap_or_default();
        if subrole == "AXSecureTextField"
            || copied_boolean(current.0, "AXEnabled").is_some_and(|enabled| !enabled)
        {
            return None;
        }

        if copied_boolean(current.0, "AXIsEditable") == Some(true) {
            return Some(current);
        }

        // Browser accessibility trees expose this relationship for contenteditable
        // descendants without marking the surrounding AXWebArea itself as editable.
        if let Some(editable_ancestor) = copied_value(current.0, "AXEditableAncestor") {
            let editable_ancestor = OwnedAxElement(editable_ancestor as AXUIElementRef);
            let secure = copied_string(editable_ancestor.0, "AXSubrole").as_deref()
                == Some("AXSecureTextField");
            let enabled = copied_boolean(editable_ancestor.0, "AXEnabled") != Some(false);
            if !secure && enabled {
                return Some(editable_ancestor);
            }
        }

        let role = copied_string(current.0, "AXRole").unwrap_or_default();
        if matches!(role.as_str(), "AXTextField" | "AXTextArea" | "AXComboBox")
            && attribute_is_settable(current.0, "AXValue")
        {
            return Some(current);
        }

        let parent = copied_value(current.0, "AXParent").map(|value| value as AXUIElementRef);
        let parent = parent?;
        current = OwnedAxElement(parent);
    }
    None
}

unsafe fn element_is_confidently_editable(element: AXUIElementRef) -> bool {
    confidently_editable_target(element).is_some()
}

unsafe fn focus_editable_target(element: AXUIElementRef, process_id: i32) {
    let application = AXUIElementCreateApplication(process_id);
    if !application.is_null() {
        let focused_element = attribute("AXFocusedUIElement");
        let _ = AXUIElementSetAttributeValue(
            application,
            focused_element.as_concrete_TypeRef(),
            element as CFTypeRef,
        );
        CFRelease(application as CFTypeRef);
    }

    let focused = attribute("AXFocused");
    let enabled = CFBoolean::true_value();
    let _ = AXUIElementSetAttributeValue(
        element,
        focused.as_concrete_TypeRef(),
        enabled.as_CFTypeRef(),
    );
}

fn replacement_capability_from_support(
    direct_accessibility: bool,
    editable: bool,
) -> ReplacementCapability {
    if direct_accessibility {
        ReplacementCapability::Accessibility
    } else if editable {
        ReplacementCapability::ClipboardPaste
    } else {
        ReplacementCapability::None
    }
}

unsafe fn replacement_capability(element: AXUIElementRef) -> ReplacementCapability {
    replacement_capability_from_support(
        attribute_is_settable(element, "AXSelectedText"),
        element_is_confidently_editable(element),
    )
}

fn ranges_match(original: Option<CFRange>, current: Option<CFRange>) -> bool {
    original.is_some() && original == current
}

unsafe fn selection_range_matches(target: &SelectionTarget, element: AXUIElementRef) -> bool {
    ranges_match(target.range, copied_range(element, "AXSelectedTextRange"))
}

unsafe fn target_has_keyboard_focus(target: AXUIElementRef, process_id: i32) -> bool {
    let application = OwnedAxElement(AXUIElementCreateApplication(process_id));
    if application.0.is_null() {
        std::mem::forget(application);
        return false;
    }
    let Some(focused) = copied_value(application.0, "AXFocusedUIElement") else {
        return false;
    };
    let focused = OwnedAxElement(focused);
    CFEqual(focused.0, target) != 0
        || confidently_editable_target(focused.0)
            .is_some_and(|editable| CFEqual(editable.0, target) != 0)
}

fn replace_utf16_range(value: &str, range: CFRange, replacement: &str) -> Option<String> {
    let units = value.encode_utf16().collect::<Vec<_>>();
    let start = usize::try_from(range.location).ok()?;
    let end = start.checked_add(usize::try_from(range.length).ok()?)?;
    if end > units.len() {
        return None;
    }
    let mut result = units[..start].to_vec();
    result.extend(replacement.encode_utf16());
    result.extend_from_slice(&units[end..]);
    String::from_utf16(&result).ok()
}

unsafe fn expected_value(
    element: AXUIElementRef,
    range: Option<CFRange>,
    text: &str,
) -> Option<String> {
    replace_utf16_range(&copied_string(element, "AXValue")?, range?, text)
}

fn verify_replacement(element: AXUIElementRef, expected: Option<&str>, replacement: &str) -> bool {
    let started = Instant::now();
    while started.elapsed() < REPLACEMENT_VERIFY_TIMEOUT {
        let verified = unsafe {
            if let Some(expected) = expected {
                copied_string(element, "AXValue").as_deref() == Some(expected)
            } else {
                selected_text(element).as_deref() == Some(replacement)
            }
        };
        if verified {
            return true;
        }
        std::thread::sleep(REPLACEMENT_VERIFY_INTERVAL);
    }
    false
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

enum SelectedElementResult {
    Selection(AXUIElementRef, String),
    Secure,
    None,
}

unsafe fn selected_element(mut element: AXUIElementRef) -> SelectedElementResult {
    // Browsers and custom controls often keep keyboard focus on a descendant while
    // exposing the selection on a text/web-area ancestor.
    for _ in 0..32 {
        let subrole = copied_string(element, "AXSubrole").unwrap_or_default();
        if subrole == "AXSecureTextField" {
            CFRelease(element as CFTypeRef);
            return SelectedElementResult::Secure;
        }
        if let Some(text) = selected_text(element) {
            return SelectedElementResult::Selection(element, text);
        }
        let parent = copied_value(element, "AXParent").map(|value| value as AXUIElementRef);
        CFRelease(element as CFTypeRef);
        let Some(parent) = parent else {
            return SelectedElementResult::None;
        };
        element = parent;
    }
    CFRelease(element as CFTypeRef);
    SelectedElementResult::None
}

unsafe fn selection_targets(
    selection_point: Option<SelectionBounds>,
) -> Option<SelectionCandidates> {
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
    let hit_tested = selection_point.or_else(cursor_bounds).and_then(|bounds| {
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
    let focused_index = focused.map(|focused| {
        let index = targets.len();
        targets.push(focused as AXUIElementRef);
        index
    });
    let hit_tested_index = hit_tested.map(|hit_tested| {
        let index = targets.len();
        targets.push(hit_tested);
        index
    });
    if process_id > 0 {
        Some((targets, process_id, focused_index, hit_tested_index))
    } else {
        for target in targets {
            CFRelease(target as CFTypeRef);
        }
        None
    }
}

fn fallback_target_index(
    origin: InteractionOrigin,
    focused_index: Option<usize>,
    hit_tested_index: Option<usize>,
) -> Option<usize> {
    match origin {
        InteractionOrigin::Pointer => hit_tested_index,
        InteractionOrigin::Keyboard => focused_index,
    }
}

fn ordered_target_indices(
    origin: Option<InteractionOrigin>,
    focused_index: Option<usize>,
    hit_tested_index: Option<usize>,
) -> [Option<usize>; 2] {
    if origin == Some(InteractionOrigin::Pointer) {
        // A webpage may leave keyboard focus in an editable composer while the user
        // selects unrelated document text with the pointer. Do not let that stale
        // focused selection override the element at the actual selection endpoint.
        [hit_tested_index, None]
    } else if origin == Some(InteractionOrigin::Keyboard) {
        [focused_index, None]
    } else {
        [focused_index, hit_tested_index]
    }
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

fn frontmost_process_id() -> i32 {
    objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .as_ref()
        .map(|application| application.processIdentifier())
        .unwrap_or_default()
}

unsafe fn window_title(element: AXUIElementRef) -> Option<String> {
    let window = copied_value(element, "AXWindow")?;
    let title = copied_string(window as AXUIElementRef, "AXTitle");
    CFRelease(window);
    title
}

unsafe fn selection_bounds(element: AXUIElementRef) -> Option<SelectionBounds> {
    let range = copied_value(element, "AXSelectedTextRange")?;
    if CFGetTypeID(range) != AXValueGetTypeID() {
        CFRelease(range);
        return None;
    }
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
        if !raw_bounds.is_null() {
            CFRelease(raw_bounds);
        }
        return None;
    }

    if CFGetTypeID(raw_bounds) != AXValueGetTypeID() {
        CFRelease(raw_bounds);
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

fn event_process_id(event: &CGEvent) -> i32 {
    event
        .get_integer_value_field(EventField::EVENT_TARGET_UNIX_PROCESS_ID)
        .try_into()
        .unwrap_or_default()
}

fn is_modifier_key(key_code: u16) -> bool {
    matches!(
        key_code,
        KeyCode::COMMAND
            | KeyCode::RIGHT_COMMAND
            | KeyCode::SHIFT
            | KeyCode::RIGHT_SHIFT
            | KeyCode::OPTION
            | KeyCode::RIGHT_OPTION
            | KeyCode::CONTROL
            | KeyCode::RIGHT_CONTROL
            | KeyCode::CAPS_LOCK
            | KeyCode::FUNCTION
    )
}

fn keyboard_interaction_kind(key_code: u16, flags: CGEventFlags) -> Option<InteractionKind> {
    let command = flags.contains(CGEventFlags::CGEventFlagCommand);
    let shift = flags.contains(CGEventFlags::CGEventFlagShift);
    let control = flags.contains(CGEventFlags::CGEventFlagControl);
    let navigation = matches!(
        key_code,
        KeyCode::LEFT_ARROW
            | KeyCode::RIGHT_ARROW
            | KeyCode::UP_ARROW
            | KeyCode::DOWN_ARROW
            | KeyCode::HOME
            | KeyCode::END
            | KeyCode::PAGE_UP
            | KeyCode::PAGE_DOWN
    );

    if (command && key_code == KeyCode::ANSI_A) || (shift && navigation) {
        Some(InteractionKind::SelectionCandidate)
    } else if navigation
        || key_code == KeyCode::ESCAPE
        || (!command && !control && !is_modifier_key(key_code))
    {
        // Navigation without Shift and ordinary typing normally collapse a selection.
        Some(InteractionKind::ClearSelection)
    } else {
        // Command shortcuts (including the synthetic Cmd+C below) do not change the
        // gesture state. This also prevents the fallback from triggering itself.
        None
    }
}

fn mouse_interaction_kind(
    distance_squared: f64,
    saw_drag_event: bool,
    click_count: i64,
    shift_click: bool,
) -> InteractionKind {
    if saw_drag_event
        || distance_squared >= MINIMUM_DRAG_DISTANCE_SQUARED
        || click_count >= 2
        || shift_click
    {
        InteractionKind::SelectionCandidate
    } else {
        InteractionKind::ClearSelection
    }
}

fn record_mouse_event(state: &Arc<Mutex<GestureState>>, event_type: CGEventType, event: &CGEvent) {
    if event_process_id(event) == std::process::id() as i32 {
        return;
    }
    let point = event.location();
    let process_id = event_process_id(event);
    let Ok(mut state) = state.lock() else {
        return;
    };
    match event_type {
        CGEventType::LeftMouseDown => {
            state.mouse_dragged = false;
            state.mouse_down = Some(MouseDown {
                x: point.x,
                y: point.y,
                process_id,
            });
            return;
        }
        CGEventType::LeftMouseDragged => {
            state.mouse_dragged = true;
            return;
        }
        CGEventType::LeftMouseUp => {}
        _ => return,
    }

    let Some(down) = state.mouse_down.take() else {
        return;
    };
    let dx = point.x - down.x;
    let dy = point.y - down.y;
    let click_count = event.get_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE);
    let saw_drag_event = state.mouse_dragged;
    state.mouse_dragged = false;
    let shift_click = event.get_flags().contains(CGEventFlags::CGEventFlagShift);
    let kind = mouse_interaction_kind(dx * dx + dy * dy, saw_drag_event, click_count, shift_click);
    state.record(
        kind,
        InteractionOrigin::Pointer,
        if process_id > 0 {
            process_id
        } else {
            down.process_id
        },
        SelectionBounds {
            x: point.x,
            y: point.y,
            width: 1.0,
            height: 18.0,
        },
    );
}

fn record_keyboard_event(state: &Arc<Mutex<GestureState>>, event: &CGEvent) {
    if event_process_id(event) == std::process::id() as i32 {
        return;
    }
    let key_code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
    let Some(kind) = keyboard_interaction_kind(key_code, event.get_flags()) else {
        return;
    };
    let bounds = cursor_bounds().unwrap_or(SelectionBounds {
        x: 8.0,
        y: 8.0,
        width: 1.0,
        height: 18.0,
    });
    if let Ok(mut state) = state.lock() {
        state.record(
            kind,
            InteractionOrigin::Keyboard,
            event_process_id(event),
            bounds,
        );
    }
}

impl ClipboardSnapshot {
    fn capture() -> Result<Self, String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        let change_count = pasteboard.changeCount();
        let mut snapshot = Self {
            change_count,
            items: Vec::new(),
        };
        let mut total_bytes = 0usize;

        if let Some(items) = pasteboard.pasteboardItems() {
            for item in items.iter() {
                let mut entries = Vec::new();
                for data_type in item.types().iter() {
                    let data = item.dataForType(&data_type).ok_or_else(|| {
                        format!("Clipboard type {data_type} could not be materialized")
                    })?;
                    total_bytes = total_bytes
                        .checked_add(data.len())
                        .ok_or("Clipboard snapshot is too large")?;
                    if total_bytes > MAX_CLIPBOARD_SNAPSHOT_BYTES {
                        return Err(format!(
                            "Clipboard exceeds the {} MiB safe snapshot limit",
                            MAX_CLIPBOARD_SNAPSHOT_BYTES / 1024 / 1024
                        ));
                    }
                    entries.push(ClipboardEntry {
                        data_type: data_type.to_string(),
                        data: data.to_vec(),
                    });
                }
                if entries.is_empty() {
                    return Err("Clipboard contains an item with no restorable data types".into());
                }
                snapshot.items.push(entries);
            }
        }

        if pasteboard.changeCount() != change_count {
            return Err("Clipboard changed while it was being snapshotted".into());
        }
        Ok(snapshot)
    }

    fn restore_if_unchanged(&self, expected_change_count: isize) -> Result<bool, String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        if pasteboard.changeCount() != expected_change_count {
            return Ok(false);
        }

        let mut writers: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = Vec::new();
        for entries in &self.items {
            let item = NSPasteboardItem::new();
            for entry in entries {
                let data_type = NSString::from_str(&entry.data_type);
                let data = NSData::with_bytes(&entry.data);
                if !item.setData_forType(&data, &data_type) {
                    return Err(format!(
                        "Could not reconstruct clipboard type {}",
                        entry.data_type
                    ));
                }
            }
            writers.push(ProtocolObject::from_retained(item));
        }
        let objects = NSArray::from_retained_slice(&writers);

        // This second check narrows the only unavoidable race: NSPasteboard does not
        // provide an atomic compare-and-swap operation for clipboard owners.
        if pasteboard.changeCount() != expected_change_count {
            return Ok(false);
        }
        pasteboard.clearContents();
        if !writers.is_empty() && !pasteboard.writeObjects(&objects) {
            return Err("Could not restore the previous clipboard contents".into());
        }
        Ok(true)
    }
}

fn post_copy_shortcut(process_id: i32) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "Could not create a keyboard event source")?;
    let down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_C, true)
        .map_err(|_| "Could not create the copy key-down event")?;
    let up = CGEvent::new_keyboard_event(source, KeyCode::ANSI_C, false)
        .map_err(|_| "Could not create the copy key-up event")?;
    down.set_flags(CGEventFlags::CGEventFlagCommand);
    up.set_flags(CGEventFlags::CGEventFlagCommand);
    down.post_to_pid(process_id);
    std::thread::sleep(Duration::from_millis(20));
    up.post_to_pid(process_id);
    Ok(())
}

fn capture_via_clipboard(process_id: i32) -> Result<Option<String>, String> {
    if frontmost_process_id() != process_id {
        return Ok(None);
    }
    let snapshot = ClipboardSnapshot::capture()?;
    let pasteboard = NSPasteboard::generalPasteboard();
    if pasteboard.changeCount() != snapshot.change_count {
        return Ok(None);
    }
    if frontmost_process_id() != process_id {
        return Ok(None);
    }
    post_copy_shortcut(process_id)?;

    let started = Instant::now();
    let mut captured_change_count = None;
    let mut captured_text = None;
    while started.elapsed() < COPY_TIMEOUT {
        let current = pasteboard.changeCount();
        match captured_change_count {
            None if current != snapshot.change_count => captured_change_count = Some(current),
            Some(first_change) if current != first_change => {
                // Another clipboard owner wrote during the transaction. Never overwrite it,
                // and do not mistake that unrelated content for the selected text.
                return Ok(None);
            }
            _ => {}
        }

        if captured_change_count.is_some() {
            captured_text = pasteboard
                .stringForType(unsafe { NSPasteboardTypeString })
                .map(|value| value.to_string())
                .filter(|value| !value.is_empty());
            if captured_text.is_some() {
                break;
            }
        }
        std::thread::sleep(CLIPBOARD_POLL_INTERVAL);
    }

    if let Some(change_count) = captured_change_count {
        if let Err(error) = snapshot.restore_if_unchanged(change_count) {
            eprintln!("Could not restore clipboard after selection capture: {error}");
        }
    }
    if frontmost_process_id() != process_id {
        return Ok(None);
    }
    Ok(captured_text)
}

impl MacOsAdapter {
    fn start_gesture_monitor(&self) -> Result<(), String> {
        // Creating a keyboard event tap before Accessibility is granted makes macOS
        // show a separate Input Monitoring prompt, and the untrusted tap keeps
        // missing keyboard events until Latch restarts. Accessibility alone
        // authorizes this listen-only tap, so wait for it.
        if !unsafe { AXIsProcessTrusted() } {
            return Err("Accessibility permission has not been granted".into());
        }
        if self.gesture_monitor_started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let gesture_state = self.gesture_state.clone();
        let (sender, receiver) = mpsc::sync_channel::<Result<(), String>>(1);
        std::thread::spawn(move || {
            let failure_sender = sender.clone();
            let ready_sender = sender.clone();
            let callback_state = gesture_state.clone();
            let installed = CGEventTap::with_enabled(
                CGEventTapLocation::Session,
                CGEventTapPlacement::TailAppendEventTap,
                CGEventTapOptions::ListenOnly,
                vec![
                    CGEventType::LeftMouseDown,
                    CGEventType::LeftMouseUp,
                    CGEventType::LeftMouseDragged,
                    CGEventType::KeyUp,
                ],
                move |_proxy, event_type, event| {
                    let process_id = event_process_id(event);
                    if process_id == std::process::id() as i32 {
                        if matches!(
                            event_type,
                            CGEventType::LeftMouseDown
                                | CGEventType::LeftMouseUp
                                | CGEventType::LeftMouseDragged
                        ) {
                            if let Ok(mut state) = callback_state.lock() {
                                state.mouse_down = None;
                                state.mouse_dragged = false;
                            }
                        }
                        return CallbackResult::Keep;
                    }
                    match event_type {
                        CGEventType::LeftMouseDown
                        | CGEventType::LeftMouseUp
                        | CGEventType::LeftMouseDragged => {
                            record_mouse_event(&callback_state, event_type, event)
                        }
                        CGEventType::KeyUp => {
                            if !KEYBOARD_EVENTS_OBSERVED.swap(true, Ordering::Relaxed) {
                                eprintln!("Selection gesture monitor is receiving keyboard events");
                            }
                            record_keyboard_event(&callback_state, event)
                        }
                        _ => {}
                    }
                    CallbackResult::Keep
                },
                move || {
                    let _ = ready_sender.send(Ok(()));
                    CFRunLoop::run_current();
                },
            );
            if installed.is_err() {
                let _ = failure_sender.send(Err(
                    "macOS declined the passive keyboard and pointer event tap".into(),
                ));
            }
        });

        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(())) => {
                eprintln!("Selection gesture monitor started");
                Ok(())
            }
            Ok(Err(error)) => {
                self.gesture_monitor_started.store(false, Ordering::SeqCst);
                Err(error)
            }
            Err(_) => {
                self.gesture_monitor_started.store(false, Ordering::SeqCst);
                Err("Timed out while starting the selection gesture monitor".into())
            }
        }
    }

    fn latest_interaction(&self) -> Result<Option<SelectionInteraction>, String> {
        self.gesture_state
            .lock()
            .map(|state| state.latest.clone())
            .map_err(|_| "Selection gesture state is unavailable".into())
    }

    fn consume_interaction(
        &self,
        interaction: Option<SelectionInteraction>,
    ) -> Result<Option<SelectionInteraction>, String> {
        let Some(interaction) = interaction else {
            return Ok(None);
        };
        let mut processed = self
            .processed_interaction
            .lock()
            .map_err(|_| "Selection gesture state is unavailable")?;
        if interaction.generation <= *processed {
            return Ok(None);
        }
        *processed = interaction.generation;
        Ok(Some(interaction))
    }

    fn mark_interaction_processed(
        &self,
        interaction: Option<&SelectionInteraction>,
    ) -> Result<(), String> {
        let Some(interaction) = interaction else {
            return Ok(());
        };
        let mut processed = self
            .processed_interaction
            .lock()
            .map_err(|_| "Selection gesture state is unavailable")?;
        *processed = (*processed).max(interaction.generation);
        Ok(())
    }

    fn clear_selection_state(&self) {
        if let Ok(mut value) = self.fallback_bounds.lock() {
            *value = None;
        }
        if let Ok(mut value) = self.fallback_selection.lock() {
            *value = None;
        }
        if let Ok(mut value) = self.last_selection.lock() {
            *value = None;
        }
        if let Ok(mut value) = self.target.lock() {
            *value = None;
        }
    }

    fn clear_if_process_changed(&self, process_id: i32) {
        let changed = self
            .last_selection
            .lock()
            .ok()
            .and_then(|selection| {
                selection
                    .as_ref()
                    .map(|value| value.process_id != process_id)
            })
            .unwrap_or(false);
        if changed {
            self.clear_selection_state();
        }
    }

    fn cached_fallback(&self, process_id: i32) -> Result<Option<NativeSelection>, String> {
        let mut cached = self
            .fallback_selection
            .lock()
            .map_err(|_| "Fallback selection cache is unavailable")?;
        let valid = cached.as_ref().is_some_and(|value| {
            value.selection.process_id == process_id
                && value.captured_at.elapsed() < FALLBACK_CACHE_LIFETIME
        });
        if !valid {
            *cached = None;
        }
        Ok(cached.as_ref().map(|value| value.selection.clone()))
    }

    fn paste_to_target(
        &self,
        text: &str,
        target: &SelectionTarget,
    ) -> Result<ReplacementResult, String> {
        let editable = target
            .paste_element
            .ok_or("The editable control is no longer available")?;
        let selection_element = target.selection_element.unwrap_or(editable);
        unsafe {
            if !element_is_confidently_editable(editable) {
                return Err("The original control is no longer editable".into());
            }
            // Focus only the retained editor, never a newly hit-tested element.
            focus_editable_target(editable, target.process_id);
        }
        if frontmost_process_id() != target.process_id {
            return Err("The source application is no longer active".into());
        }
        let observed = unsafe { selected_text(selection_element) };
        let observed = match observed {
            Some(text) => Some(text),
            None => capture_via_clipboard(target.process_id)?,
        };
        if observed.as_deref() != Some(target.selected_text.as_str())
            || !unsafe { selection_range_matches(target, selection_element) }
            || !unsafe { target_has_keyboard_focus(editable, target.process_id) }
        {
            return Err("The original editable selection changed or cannot be verified. Copy the answer and paste it manually.".into());
        }
        let expected = unsafe { expected_value(selection_element, target.range, text) };
        let snapshot = ClipboardSnapshot::capture()?;
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "Could not create a keyboard event source")?;
        let down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true)
            .map_err(|_| "Could not create the paste key-down event")?;
        let up = CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, false)
            .map_err(|_| "Could not create the paste key-up event")?;
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        if NSPasteboard::generalPasteboard().changeCount() != snapshot.change_count {
            return Err("Clipboard changed before replacement; try again".into());
        }
        self.copy_text(text)?;
        let change_count = NSPasteboard::generalPasteboard().changeCount();
        // Revalidate after the clipboard snapshot, which may materialize slow data.
        if frontmost_process_id() != target.process_id
            || !unsafe { target_has_keyboard_focus(editable, target.process_id) }
            || !unsafe { selection_range_matches(target, selection_element) }
            || unsafe { selected_text(selection_element) }.as_deref() != Some(target.selected_text.as_str())
            || NSPasteboard::generalPasteboard().changeCount() != change_count
        {
            let _ = snapshot.restore_if_unchanged(change_count);
            return Err("The source selection changed before paste".into());
        }
        down.post_to_pid(target.process_id);
        std::thread::sleep(Duration::from_millis(20));
        up.post_to_pid(target.process_id);
        let verified = verify_replacement(selection_element, expected.as_deref(), text);
        if verified {
            let _ = snapshot.restore_if_unchanged(change_count);
        }
        // A missing/collapsed AX selection does not prove success. Leave the answer
        // on the clipboard when the editor cannot acknowledge consumption, and let
        // the UI report an unverified dispatch without retrying a destructive action.
        Ok(ReplacementResult {
            method: "clipboard-paste",
            verified,
        })
    }
}

impl PlatformAdapter for MacOsAdapter {
    fn start_selection_tracking(&self) -> Result<(), String> {
        self.start_gesture_monitor()
    }

    fn selection_tracking_running(&self) -> bool {
        self.gesture_monitor_started.load(Ordering::SeqCst)
    }

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
            implementation: "axuielement+guarded-clipboard",
            monitor_running: false,
            context_bar_ready: false,
            selection_tracking: false,
            restart_recommended: false,
        }
    }

    fn capture_selection(
        &self,
        excluded_applications: &[String],
    ) -> Result<Option<NativeSelection>, String> {
        if !unsafe { AXIsProcessTrusted() } {
            return Ok(None);
        }
        let interaction = self.latest_interaction()?;
        let selection_point = interaction
            .as_ref()
            .filter(|event| {
                event.origin == InteractionOrigin::Pointer
                    && event.occurred_at.elapsed() <= GESTURE_FRESHNESS
            })
            .map(|event| event.bounds.clone());
        unsafe {
            let Some((targets, process_id, focused_index, hit_tested_index)) =
                selection_targets(selection_point)
            else {
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
            self.clear_if_process_changed(process_id);
            let application = process_name(process_id);
            if excluded_applications
                .iter()
                .any(|excluded| application.eq_ignore_ascii_case(excluded))
            {
                for target in targets {
                    CFRelease(target as CFTypeRef);
                }
                self.clear_selection_state();
                return Ok(None);
            }

            if interaction.as_ref().is_some_and(|interaction| {
                interaction.kind == InteractionKind::ClearSelection
                    && interaction.occurred_at.elapsed() <= GESTURE_FRESHNESS
                    && (interaction.process_id <= 0 || interaction.process_id == process_id)
            }) {
                self.mark_interaction_processed(interaction.as_ref())?;
                for target in targets {
                    CFRelease(target);
                }
                self.clear_selection_state();
                return Ok(None);
            }
            let generation = interaction
                .as_ref()
                .map_or(0, |interaction| interaction.generation);
            let unchanged = self
                .target
                .lock()
                .map_err(|_| "Selection target is unavailable")?
                .as_ref()
                .is_some_and(|target| {
                    target.generation == generation
                        && target.process_id == process_id
                        && target.selection_element.is_some_and(|element| {
                            selected_text(element).as_deref() == Some(target.selected_text.as_str())
                                && (target.range.is_none() || selection_range_matches(target, element))
                        })
                });
            if unchanged {
                for target in targets {
                    CFRelease(target);
                }
                return self
                    .last_selection
                    .lock()
                    .map(|value| value.clone())
                    .map_err(|_| "Last selection state is unavailable".into());
            }

            let title = targets.iter().find_map(|target| window_title(*target));
            let mut selected = None;
            let mut secure = false;
            let targeting_origin = interaction
                .as_ref()
                .filter(|interaction| {
                    interaction.occurred_at.elapsed() <= GESTURE_FRESHNESS
                        && (interaction.process_id <= 0 || interaction.process_id == process_id)
                })
                .map(|interaction| interaction.origin);
            let target_indices =
                ordered_target_indices(targeting_origin, focused_index, hit_tested_index);
            for target in target_indices
                .into_iter()
                .flatten()
                .filter_map(|index| targets.get(index))
            {
                // selected_element owns and releases the element it traverses. Retain a
                // separate reference so the original targets remain available for the
                // guarded clipboard fallback classification below.
                let retained = CFRetain(*target as CFTypeRef) as AXUIElementRef;
                match selected_element(retained) {
                    SelectedElementResult::Selection(element, text) => {
                        selected = Some((element, text));
                        break;
                    }
                    SelectedElementResult::Secure => {
                        secure = true;
                        break;
                    }
                    SelectedElementResult::None => {}
                }
            }
            let fallback_target = if !secure && selected.is_none() {
                interaction
                    .as_ref()
                    .and_then(|interaction| {
                        fallback_target_index(interaction.origin, focused_index, hit_tested_index)
                    })
                    .and_then(|index| targets.get(index).copied())
                    .and_then(|target| confidently_editable_target(target))
            } else {
                None
            };
            for target in targets {
                CFRelease(target as CFTypeRef);
            }
            if secure {
                self.mark_interaction_processed(interaction.as_ref())?;
                self.clear_selection_state();
                return Ok(None);
            }

            if selected.is_none() {
                let Some(interaction) = self.consume_interaction(interaction)? else {
                    return self.cached_fallback(process_id);
                };
                if interaction.kind == InteractionKind::ClearSelection
                    || interaction.occurred_at.elapsed() > GESTURE_FRESHNESS
                    || (interaction.process_id > 0 && interaction.process_id != process_id)
                {
                    self.clear_selection_state();
                    return Ok(None);
                }

                let text = match capture_via_clipboard(process_id) {
                    Ok(Some(text)) => text,
                    Ok(None) => {
                        self.clear_selection_state();
                        return Ok(None);
                    }
                    Err(error) => {
                        // A failed snapshot is deliberately non-destructive: no Cmd+C is
                        // sent unless the old pasteboard can be reconstructed first.
                        eprintln!("Guarded clipboard selection capture skipped: {error}");
                        self.clear_selection_state();
                        return Ok(None);
                    }
                };
                let range = fallback_target.as_ref().and_then(|target| copied_range(target.0, "AXSelectedTextRange"));
                let replacement_capability = if fallback_target.is_some() && range.is_some() {
                    ReplacementCapability::ClipboardPaste
                } else {
                    ReplacementCapability::None
                };
                let selection_id = uuid::Uuid::new_v4().to_string();
                let selection = NativeSelection {
                    selection_id: selection_id.clone(),
                    text: text.clone(),
                    application,
                    window_title: title,
                    process_id,
                    bounds: interaction.bounds,
                    replacement_capability,
                    replacement_unavailable_reason: range.is_none().then(|| "The editor cannot verify the original selection position. Copy the answer instead.".into()),
                };
                *self
                    .target
                    .lock()
                    .map_err(|_| "Selection target is unavailable")? = Some(SelectionTarget {
                    selection_id,
                    range,
                    generation: interaction.generation,
                    selection_element: None,
                    paste_element: fallback_target.map(OwnedAxElement::into_raw),
                    process_id,
                    selected_text: text,
                    replacement_capability,
                });
                *self
                    .fallback_selection
                    .lock()
                    .map_err(|_| "Fallback selection cache is unavailable")? =
                    Some(CachedFallbackSelection {
                        selection: selection.clone(),
                        captured_at: Instant::now(),
                    });
                *self
                    .last_selection
                    .lock()
                    .map_err(|_| "Last selection state is unavailable")? = Some(selection.clone());
                return Ok(Some(selection));
            }

            self.mark_interaction_processed(interaction.as_ref())?;
            if let Ok(mut cached) = self.fallback_selection.lock() {
                *cached = None;
            }
            let (focused, text) = selected.expect("selection checked above");
            let focused = OwnedAxElement(focused);
            let range = copied_range(focused.0, "AXSelectedTextRange");
            let generation = interaction
                .as_ref()
                .map_or(0, |interaction| interaction.generation);
            let unchanged = self
                .target
                .lock()
                .map_err(|_| "Selection target is unavailable")?
                .as_ref()
                .is_some_and(|target| {
                    target.process_id == process_id
                        && target.selected_text == text
                        && target.range == range
                        && target.generation == generation
                        && target
                            .selection_element
                            .is_some_and(|element| CFEqual(element, focused.0) != 0)
                });
            if unchanged {
                return self
                    .last_selection
                    .lock()
                    .map(|selection| selection.clone())
                    .map_err(|_| "Last selection state is unavailable".into());
            }
            let selection_id = uuid::Uuid::new_v4().to_string();

            // Some WebKit/Electron controls expose AXSelectedText but not AXBoundsForRange.
            // Cache the pointer fallback for this selection so clicking the Context Bar does
            // not make the unchanged selection look new just because the pointer moved.
            let bounds = if let Some(bounds) = selection_bounds(focused.0) {
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
            let replacement_capability = if range.is_some() { replacement_capability(focused.0) } else { ReplacementCapability::None };
            let paste_element = (replacement_capability != ReplacementCapability::None)
                .then(|| confidently_editable_target(focused.0))
                .flatten()
                .map(OwnedAxElement::into_raw);
            let selection_target = SelectionTarget {
                selection_id: selection_id.clone(),
                range,
                generation,
                selection_element: Some(focused.into_raw()),
                paste_element,
                process_id,
                selected_text: text.clone(),
                replacement_capability,
            };
            *self
                .target
                .lock()
                .map_err(|_| "Selection target is unavailable")? = Some(selection_target);
            let selection = NativeSelection {
                selection_id,
                text,
                application,
                window_title: title,
                process_id,
                bounds,
                replacement_capability,
                replacement_unavailable_reason: range.is_none().then(|| "The editor cannot verify the original selection position. Copy the answer instead.".into()),
            };
            *self
                .last_selection
                .lock()
                .map_err(|_| "Last selection state is unavailable")? = Some(selection.clone());
            Ok(Some(selection))
        }
    }

    fn replace_selection(
        &self,
        text: &str,
        selection_id: &str,
    ) -> Result<ReplacementResult, String> {
        let mut stored = self
            .target
            .lock()
            .map_err(|_| "Selection target is unavailable")?;
        let target = stored
            .as_ref()
            .ok_or("The original selection is no longer available")?;
        if target.selection_id != selection_id {
            return Err(
                "The original selection changed. Select the text again before replacing it.".into(),
            );
        }
        if frontmost_process_id() != target.process_id {
            return Err("The source application is no longer active".into());
        }
        if target.range.is_none() {
            return Err("The editor cannot verify the original selection position. Copy the answer instead.".into());
        }
        let result = match target.replacement_capability {
            ReplacementCapability::None => Err("The original selection is not editable".into()),
            ReplacementCapability::Accessibility => {
                let element = target
                    .selection_element
                    .ok_or("The editable selection target is no longer available")?;
                let mut pid = 0;
                let current = unsafe {
                    AXUIElementGetPid(element, &mut pid) == 0
                        && pid == target.process_id
                        && selected_text(element).as_deref() == Some(target.selected_text.as_str())
                        && selection_range_matches(target, element)
                        && target_has_keyboard_focus(target.paste_element.unwrap_or(element), target.process_id)
                        && attribute_is_settable(element, "AXSelectedText")
                };
                if !current {
                    return Err("The original editable selection has changed".into());
                }
                let before = unsafe { copied_string(element, "AXValue") };
                let expected = unsafe { expected_value(element, target.range, text) };
                let replacement = CFString::new(text);
                if frontmost_process_id() != target.process_id || !unsafe {
                    target_has_keyboard_focus(target.paste_element.unwrap_or(element), target.process_id)
                        && selected_text(element).as_deref() == Some(target.selected_text.as_str())
                        && selection_range_matches(target, element)
                } { return Err("The original editable selection changed before replacement".into()); }
                let replaced = unsafe {
                    AXUIElementSetAttributeValue(
                        element,
                        attribute("AXSelectedText").as_concrete_TypeRef(),
                        replacement.as_CFTypeRef(),
                    ) == 0
                };
                if replaced {
                    Ok(ReplacementResult {
                        method: "accessibility",
                        verified: verify_replacement(element, expected.as_deref(), text),
                    })
                } else if before.is_some()
                    && unsafe { copied_string(element, "AXValue") } == before
                    && target.paste_element.is_some()
                    && unsafe { selected_text(element) }.as_deref()
                        == Some(target.selected_text.as_str())
                    && unsafe { selection_range_matches(target, element) }
                {
                    // Fall back only after a rejected write with an unchanged value and
                    // selection. Never paste again after an ambiguous successful write.
                    self.paste_to_target(text, target)
                } else if before.is_some() && unsafe { copied_string(element, "AXValue") } == before {
                    Err("The source application rejected replacement. Copy the answer and paste it manually.".into())
                } else {
                    // A rejected Accessibility call can still have changed the editor.
                    // Consume this ambiguous dispatch so no automatic retry can write twice.
                    Ok(ReplacementResult { method: "accessibility", verified: false })
                }
            }
            ReplacementCapability::ClipboardPaste => self.paste_to_target(text, target),
        };
        if result.is_ok() {
            *stored = None;
        }
        result
    }

    fn copy_text(&self, text: &str) -> Result<(), String> {
        let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
        clipboard.set_text(text).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_requires_the_original_position_even_for_repeated_text() {
        let first = CFRange { location: 0, length: 4 };
        let second = CFRange { location: 10, length: 4 };
        assert!(!ranges_match(None, None));
        assert!(!ranges_match(Some(first), None));
        assert!(!ranges_match(Some(first), Some(second)));
        assert!(ranges_match(Some(first), Some(first)));
    }

    #[test]
    fn replacement_range_uses_utf16_offsets_and_rejects_invalid_boundaries() {
        assert_eq!(
            replace_utf16_range(
                "a🙂bc",
                CFRange {
                    location: 1,
                    length: 2
                },
                "é"
            ),
            Some("aébc".into())
        );
        assert_eq!(
            replace_utf16_range(
                "abc",
                CFRange {
                    location: 9,
                    length: 1
                },
                "x"
            ),
            None
        );
        assert_eq!(
            replace_utf16_range(
                "a🙂bc",
                CFRange {
                    location: 2,
                    length: 1
                },
                "x"
            ),
            None
        );
        assert_eq!(
            replace_utf16_range(
                "abc",
                CFRange {
                    location: -1,
                    length: 1
                },
                "x"
            ),
            None
        );
    }

    #[test]
    fn stale_selection_id_is_rejected_before_any_native_write() {
        let adapter = MacOsAdapter::default();
        *adapter.target.lock().unwrap() = Some(SelectionTarget {
            selection_id: "new".into(),
            range: None,
            generation: 2,
            selection_element: None,
            paste_element: None,
            process_id: 0,
            selected_text: "same words".into(),
            replacement_capability: ReplacementCapability::ClipboardPaste,
        });
        assert!(adapter
            .replace_selection("replacement", "old")
            .unwrap_err()
            .contains("selection changed"));
    }

    #[test]
    fn direct_replacement_takes_precedence_over_paste() {
        assert_eq!(
            replacement_capability_from_support(true, true),
            ReplacementCapability::Accessibility
        );
    }

    #[test]
    fn editable_custom_controls_use_guarded_paste() {
        assert_eq!(
            replacement_capability_from_support(false, true),
            ReplacementCapability::ClipboardPaste
        );
    }

    #[test]
    fn unknown_or_read_only_elements_cannot_be_replaced() {
        assert_eq!(
            replacement_capability_from_support(false, false),
            ReplacementCapability::None
        );
    }

    #[test]
    fn pointer_fallback_uses_only_the_hit_tested_element() {
        assert_eq!(
            fallback_target_index(InteractionOrigin::Pointer, Some(0), Some(1)),
            Some(1)
        );
        assert_eq!(
            fallback_target_index(InteractionOrigin::Pointer, Some(0), None),
            None
        );
    }

    #[test]
    fn keyboard_fallback_uses_only_the_focused_element() {
        assert_eq!(
            fallback_target_index(InteractionOrigin::Keyboard, Some(0), Some(1)),
            Some(0)
        );
        assert_eq!(
            fallback_target_index(InteractionOrigin::Keyboard, None, Some(0)),
            None
        );
    }

    #[test]
    fn gesture_selection_uses_only_its_origin_target() {
        assert_eq!(
            ordered_target_indices(Some(InteractionOrigin::Pointer), Some(0), Some(1)),
            [Some(1), None]
        );
        assert_eq!(
            ordered_target_indices(Some(InteractionOrigin::Keyboard), Some(0), Some(1)),
            [Some(0), None]
        );
    }

    #[test]
    fn command_a_and_shift_navigation_arm_selection_capture() {
        assert_eq!(
            keyboard_interaction_kind(KeyCode::ANSI_A, CGEventFlags::CGEventFlagCommand),
            Some(InteractionKind::SelectionCandidate)
        );
        assert_eq!(
            keyboard_interaction_kind(KeyCode::RIGHT_ARROW, CGEventFlags::CGEventFlagShift),
            Some(InteractionKind::SelectionCandidate)
        );
    }

    #[test]
    fn copy_shortcuts_do_not_rearm_the_fallback() {
        assert_eq!(
            keyboard_interaction_kind(KeyCode::ANSI_C, CGEventFlags::CGEventFlagCommand),
            None
        );
        assert_eq!(
            keyboard_interaction_kind(KeyCode::ANSI_C, CGEventFlags::empty()),
            Some(InteractionKind::ClearSelection)
        );
    }

    #[test]
    fn mouse_drag_double_click_and_shift_click_are_selection_candidates() {
        assert_eq!(
            mouse_interaction_kind(0.0, true, 1, false),
            InteractionKind::SelectionCandidate
        );
        assert_eq!(
            mouse_interaction_kind(0.0, false, 2, false),
            InteractionKind::SelectionCandidate
        );
        assert_eq!(
            mouse_interaction_kind(0.0, false, 1, true),
            InteractionKind::SelectionCandidate
        );
        assert_eq!(
            mouse_interaction_kind(0.0, false, 1, false),
            InteractionKind::ClearSelection
        );
    }

    #[test]
    fn an_interaction_is_consumed_only_once() {
        let adapter = MacOsAdapter::default();
        let interaction = SelectionInteraction {
            generation: 7,
            occurred_at: Instant::now(),
            process_id: 42,
            bounds: SelectionBounds {
                x: 1.0,
                y: 2.0,
                width: 1.0,
                height: 18.0,
            },
            kind: InteractionKind::SelectionCandidate,
            origin: InteractionOrigin::Pointer,
        };

        assert!(adapter
            .consume_interaction(Some(interaction.clone()))
            .unwrap()
            .is_some());
        assert!(adapter
            .consume_interaction(Some(interaction))
            .unwrap()
            .is_none());
    }
}
