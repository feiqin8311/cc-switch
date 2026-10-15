mod support;

use cc_switch_lib::{update_settings, AppSettings, AppType, Prompt, PromptService};
use std::fs;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

#[test]
fn prompt_list_refreshes_external_edits_without_changing_inactive_templates() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let home = ensure_test_home();
    let state = create_test_state().unwrap();

    for (app, relative_path) in [
        (AppType::Claude, ".claude/CLAUDE.md"),
        (AppType::Codex, ".codex/AGENTS.md"),
    ] {
        let active = Prompt {
            id: "active".into(),
            name: "My instructions".into(),
            content: "original".into(),
            description: Some("Keep my metadata".into()),
            enabled: true,
            created_at: Some(1),
            updated_at: Some(1),
        };
        let inactive = Prompt {
            id: "inactive".into(),
            enabled: false,
            ..active.clone()
        };
        state.db.save_prompt(app.as_str(), &inactive).unwrap();
        PromptService::upsert_prompt(&state, app.clone(), &active.id, active.clone()).unwrap();
        let path = home.join(relative_path);

        for content in ["externally edited\n", "another edit\n"] {
            fs::write(&path, content).unwrap();
            let prompts = PromptService::get_prompts(&state, app.clone()).unwrap();
            assert_eq!(prompts["active"].content, content);
            assert_eq!(prompts["active"].name, active.name);
            assert_eq!(prompts["active"].description, active.description);
            assert_eq!(prompts["active"].created_at, active.created_at);
            assert!(prompts["active"].enabled);
            assert_eq!(prompts["inactive"].content, "original");
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
            assert_eq!(
                state.db.get_prompts(app.as_str()).unwrap()["active"].content,
                content
            );
        }

        let mut saved = state.db.get_prompts(app.as_str()).unwrap()["active"].clone();
        saved.content = "saved instructions".into();
        fs::write(&path, &saved.content).unwrap();
        saved.updated_at = Some(42);
        state.db.save_prompt(app.as_str(), &saved).unwrap();
        assert_eq!(
            PromptService::get_prompts(&state, app.clone()).unwrap()["active"].updated_at,
            Some(42)
        );

        for content in ["", " \t\r\n"] {
            fs::write(&path, content).unwrap();
            let prompts = PromptService::get_prompts(&state, app.clone()).unwrap();
            assert_eq!(prompts["active"].content, saved.content);
            assert_eq!(prompts["active"].updated_at, Some(42));
            assert_eq!(prompts["inactive"].content, "original");
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
            assert_eq!(
                state.db.get_prompts(app.as_str()).unwrap()["active"].content,
                saved.content
            );
        }

        // An editor may save UTF-16: the live read fails, but saved templates
        // must remain available so the user can repair the file from the UI.
        let utf16 = [0xff, 0xfe, b'A', 0];
        fs::write(&path, utf16).unwrap();
        let prompts = PromptService::get_prompts(&state, app.clone()).unwrap();
        assert_eq!(prompts["active"].content, saved.content);
        assert_eq!(prompts["active"].updated_at, Some(42));
        assert_eq!(prompts["inactive"].content, "original");
        assert_eq!(fs::read(&path).unwrap(), utf16);
        assert_eq!(
            state.db.get_prompts(app.as_str()).unwrap()["active"].updated_at,
            Some(42)
        );
        assert_eq!(
            state.db.get_prompts(app.as_str()).unwrap()["active"].content,
            saved.content
        );
        assert!(PromptService::get_current_file_content(app.clone()).is_err());

        fs::remove_file(&path).unwrap();
        assert_eq!(
            PromptService::get_prompts(&state, app.clone()).unwrap()["active"].updated_at,
            Some(42)
        );
        assert!(!path.exists());

        saved.enabled = false;
        state.db.save_prompt(app.as_str(), &saved).unwrap();
        fs::write(&path, "unmanaged instructions").unwrap();
        assert_eq!(
            PromptService::get_prompts(&state, app).unwrap()["active"].content,
            saved.content
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "unmanaged instructions");
    }
}

#[test]
fn saving_inactive_prompts_keeps_a_hand_written_file_until_the_last_enabled_one_is_disabled() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let home = ensure_test_home();
    // HERMES_HOME is not redirected by the test support; an override keeps a
    // developer's real SOUL.md out of reach.
    let hermes_dir = home.join(".hermes-prompt-live-sync");
    let _ = fs::remove_dir_all(&hermes_dir);
    update_settings(AppSettings {
        hermes_config_dir: Some(hermes_dir.to_string_lossy().into_owned()),
        ..AppSettings::default()
    })
    .unwrap();
    let state = create_test_state().unwrap();

    for (app, path) in [
        (AppType::Claude, home.join(".claude/CLAUDE.md")),
        (AppType::Codex, home.join(".codex/AGENTS.md")),
        (AppType::Hermes, hermes_dir.join("SOUL.md")),
    ] {
        let hand_written = "hand-written instructions\n";
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, hand_written).unwrap();

        // Adding a new prompt from the UI saves it disabled.
        let draft = Prompt {
            id: "draft".into(),
            name: "Draft".into(),
            content: "draft content".into(),
            description: None,
            enabled: false,
            created_at: Some(1),
            updated_at: Some(1),
        };
        PromptService::upsert_prompt(&state, app.clone(), &draft.id, draft.clone()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), hand_written);

        // Re-saving an inactive prompt leaves the file alone as well.
        let edited = Prompt {
            content: "edited draft".into(),
            ..draft.clone()
        };
        PromptService::upsert_prompt(&state, app.clone(), "draft", edited).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), hand_written);

        // Importing copies the file into the database without emptying it.
        let imported_id = PromptService::import_from_file(&state, app.clone()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), hand_written);
        assert_eq!(
            state.db.get_prompts(app.as_str()).unwrap()[&imported_id].content,
            hand_written
        );

        // A deeplink saves disabled and then enables: the hand-written file
        // must still be readable when enable_prompt backs it up.
        fs::write(&path, "fresh hand-written\n").unwrap();
        let linked = Prompt {
            id: "linked".into(),
            content: "linked content".into(),
            ..draft.clone()
        };
        PromptService::upsert_prompt(&state, app.clone(), &linked.id, linked.clone()).unwrap();
        PromptService::enable_prompt(&state, app.clone(), &linked.id).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "linked content");
        assert!(state
            .db
            .get_prompts(app.as_str())
            .unwrap()
            .values()
            .any(|prompt| !prompt.enabled && prompt.content == "fresh hand-written\n"));

        // Disabling the last enabled prompt still empties the file.
        let disabled = Prompt {
            enabled: false,
            ..state.db.get_prompts(app.as_str()).unwrap()["linked"].clone()
        };
        PromptService::upsert_prompt(&state, app.clone(), "linked", disabled).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
    }

    update_settings(AppSettings::default()).unwrap();
    let _ = fs::remove_dir_all(&hermes_dir);
}

#[test]
fn db_only_prompt_entry_points_back_up_and_clear_agents_md() {
    let _guard = test_mutex().lock().unwrap();
    reset_test_fs();
    let home = ensure_test_home();
    let state = create_test_state().unwrap();
    let path = home.join(".codex/AGENTS.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "my own instructions\n").unwrap();

    let prompt = Prompt {
        id: "enterprise-team".into(),
        name: "Team".into(),
        content: "# Team rules\n".into(),
        description: None,
        enabled: false,
        created_at: Some(1),
        updated_at: Some(1),
    };
    // Adding a disabled prompt leaves the user's file alone.
    PromptService::upsert_prompt_in(&state.db, AppType::Codex, &prompt.id, prompt.clone()).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "my own instructions\n");

    // Enabling writes it and keeps the user's content as a backup prompt.
    PromptService::enable_prompt_in(&state.db, AppType::Codex, &prompt.id).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Team rules\n");
    let prompts = state.db.get_prompts(AppType::Codex.as_str()).unwrap();
    assert!(prompts["enterprise-team"].enabled);
    assert!(prompts
        .values()
        .any(|p| !p.enabled && p.content == "my own instructions\n"));

    // Disabling the only enabled prompt clears the file.
    let disabled = Prompt {
        enabled: false,
        ..prompts["enterprise-team"].clone()
    };
    PromptService::upsert_prompt_in(&state.db, AppType::Codex, &disabled.id, disabled.clone())
        .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "");

    // Pi / MCode have their own file handling.
    assert!(
        PromptService::upsert_prompt_in(&state.db, AppType::Pi, "x", disabled.clone()).is_err()
    );
    assert!(PromptService::enable_prompt_in(&state.db, AppType::Mcode, "x").is_err());
}
