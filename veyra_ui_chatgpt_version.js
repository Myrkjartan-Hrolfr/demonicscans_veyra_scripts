

Tampermonkey® von Jan Biniok,
v5.5.0

UI Improvements
by [SEREPH] koenrad
517
                  slot.querySelector(".pet-info-overlay")?.dataset.name ||
518
                  "";
519
​
520
            if (!/Asterion/i.test(name)) return;
521
​
522
            // Look for multiplier text
523
            const powerText =
524
                  slot.querySelector(".pet-power")?.textContent ||
525
                  slot.querySelector(".pet-info-overlay")?.dataset.desc ||
526
                  "";
527
​
528
            // Match "x3", "x 3", etc.
529
            const match = powerText.match(/x\s*(\d+)/i);
530
            if (!match) return;
531
​
532
            const foundAsterionValue = Number(match[1]);
533
            if (asterionValue !== foundAsterionValue) {
534
                Storage.set("ui-improvements:asterionValue", foundAsterionValue);
535
            }
536
        });
537
    }
538
​
539
    // --------------------- Adventurer's Guild Page --------------------- //
540
    // Align the accept quest button on the Adventurer's Guild to the bottom of the element
541
    document.querySelectorAll(".quest-side").forEach((el) => {
542
        el.style.marginTop = "auto";
543
    });
544
    // --------------------- Adventurer's Guild Page --------------------- //
545
​
546
    // ------------------------ Battle Pass Page ------------------------- //
547
​
548
    const { container: syncBattlePassScrollbarsToggle } = createSettingsInput({
549
        key: "ui-improvements:syncBattlePassScrollbars",
550
        label: "Sync Scrollbars",
551
        defaultValue: true,
552
        type: "checkbox",
553
        inputProps: { slider: true },
554
    });
555
​
556
    const { container: scrollToCurrentLevelToggle } = createSettingsInput({
557
        key: "ui-improvements:scrollToCurrentLevel",
558
        label: "Auto Scroll to Current Level",
559
        defaultValue: true,
560
        type: "checkbox",
561
        inputProps: { slider: true },
562
    });
563
​
564
    addSettingsGroup(
565
        "battlepass-page",
566
        "BattlePass Settings",
