use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

fn labels(language: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    if language == "zh" {
        ("文件", "编辑", "窗口", "设置…")
    } else {
        ("File", "Edit", "Window", "Settings…")
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>, language: &str) -> tauri::Result<Menu<R>> {
    let zh = language == "zh";
    let (file_label, edit_label, window_label, settings_label) = labels(language);
    let app_name = app.package_info().name.clone();

    let settings = MenuItemBuilder::with_id("menu-settings", settings_label)
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, &app_name)
        .about_with_text(
            if zh {
                format!("关于 {app_name}")
            } else {
                format!("About {app_name}")
            },
            None,
        )
        .separator()
        .item(&settings)
        .separator()
        .services_with_text(if zh { "服务" } else { "Services" })
        .separator()
        .hide_with_text(if zh {
            format!("隐藏 {app_name}")
        } else {
            format!("Hide {app_name}")
        })
        .hide_others_with_text(if zh { "隐藏其他" } else { "Hide Others" })
        .show_all_with_text(if zh { "显示全部" } else { "Show All" })
        .separator()
        .quit_with_text(if zh {
            format!("退出 {app_name}")
        } else {
            format!("Quit {app_name}")
        })
        .build()?;

    let new_json =
        MenuItemBuilder::with_id("menu-new-json", if zh { "新建 JSON" } else { "New JSON" })
            .accelerator("CmdOrCtrl+N")
            .build(app)?;
    let open_json = MenuItemBuilder::with_id(
        "menu-open-json",
        if zh { "打开 JSON…" } else { "Open JSON…" },
    )
    .accelerator("CmdOrCtrl+O")
    .build(app)?;
    let open_stream = MenuItemBuilder::with_id(
        "menu-open-stream",
        if zh { "打开流…" } else { "Open Stream…" },
    )
    .accelerator("CmdOrCtrl+Shift+O")
    .build(app)?;
    let save = MenuItemBuilder::with_id("menu-save", if zh { "保存" } else { "Save" })
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, file_label)
        .item(&new_json)
        .item(&open_json)
        .item(&open_stream)
        .separator()
        .item(&save)
        .separator()
        .close_window_with_text(if zh { "关闭窗口" } else { "Close Window" })
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, edit_label)
        .undo_with_text(if zh { "撤销" } else { "Undo" })
        .redo_with_text(if zh { "重做" } else { "Redo" })
        .separator()
        .cut_with_text(if zh { "剪切" } else { "Cut" })
        .copy_with_text(if zh { "复制" } else { "Copy" })
        .paste_with_text(if zh { "粘贴" } else { "Paste" })
        .select_all_with_text(if zh { "全选" } else { "Select All" })
        .build()?;

    let window_menu = SubmenuBuilder::new(app, window_label)
        .minimize_with_text(if zh { "最小化" } else { "Minimize" })
        .maximize_with_text(if zh { "缩放" } else { "Zoom" })
        .separator()
        .bring_all_to_front_with_text(if zh {
            "全部置于顶层"
        } else {
            "Bring All to Front"
        })
        .build()?;

    #[cfg(debug_assertions)]
    let dev_menu = SubmenuBuilder::new(app, if zh { "开发" } else { "Develop" })
        .item(
            &MenuItemBuilder::with_id(
                "menu-dev-tools",
                if zh {
                    "开发者工具"
                } else {
                    "Developer Tools"
                },
            )
            .build(app)?,
        )
        .build()?;

    let builder = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let builder = builder.item(&app_menu);
    let builder = builder.item(&file_menu).item(&edit_menu);
    #[cfg(debug_assertions)]
    let builder = builder.item(&dev_menu);
    builder.item(&window_menu).build()
}

pub fn install<R: Runtime>(app: &AppHandle<R>, language: &str) -> tauri::Result<()> {
    let menu = build(app, language)?;
    let previous = app.set_menu(menu)?;
    drop(previous);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn localization_keys_resolve() {
        assert_eq!(super::labels("en").3, "Settings…");
        assert_eq!(super::labels("zh").3, "设置…");
    }
}
