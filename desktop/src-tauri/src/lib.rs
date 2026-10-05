use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, WebviewWindow,
};

const WINDOW_WIDTH: u32 = 420;
const WINDOW_HEIGHT: u32 = 620;
const MARGIN: i32 = 10;

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            position_near_tray(&window);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn position_near_tray(window: &WebviewWindow) {
    if let Some(monitor) = window.current_monitor().ok().flatten() {
        let screen_size = monitor.size();
        let scale = monitor.scale_factor();

        // Góc dưới phải màn hình (gần system tray trên Windows)
        let x = (screen_size.width as f64 / scale) as i32
            - WINDOW_WIDTH as i32
            - MARGIN;
        let y = (screen_size.height as f64 / scale) as i32
            - WINDOW_HEIGHT as i32
            - 50; // chừa taskbar

        let _ = window.set_position(PhysicalPosition::new(
            (x as f64 * scale) as i32,
            (y as f64 * scale) as i32,
        ));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // --- Menu cho tray ---
            let show_item = MenuItem::with_id(app, "show", "Mở chat", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "Ẩn", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

            // --- Tray icon ---
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("SOP AI Assistant")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            position_near_tray(&window);
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        toggle_window(app);
                    }
                })
                .build(app)?;

            // --- Ẩn window khi click ra ngoài ---
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
