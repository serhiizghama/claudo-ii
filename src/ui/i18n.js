// src/ui/i18n.js
//
// UI-1 — `09 §14`'s two plain dictionaries, plus the small pure helpers the
// mechanism needs (`pluralRule`, `format`, the missing-key dev check). The
// lookup/fallback contract itself (`ui.t(key, params)`, `setLanguage(lang)`)
// is public API (`02-api-contracts.md` §14) and lives on `UiSystem` in
// `./index.js` — this file only owns the data and the pure functions that
// data needs.
//
// ---------------------------------------------------------------------------
// Coverage of this ticket's dictionaries
// ---------------------------------------------------------------------------
// `09 §14.3` documents 344 keys across every screen U1-U14 eventually build,
// plus the data-owned families of `§14.2` (`item.base.<id>`, `skill.<id>.
// name`, ...) that are generated from tables `items`/`skills`/`ai`/`world`
// own and do not exist yet. U0's brief is explicit: "read the contract and
// the dictionary shape, not every string." This file's dictionaries are
// therefore the subset actually verified against `09 §14.3` in this
// ticket's own research (app/menu/slots, character creation, HUD, panels
// and tabs, common, character sheet, slot names, a sample of the tooltip
// and death/options/controls/actions/errors families) — not the full 344.
// `t()`'s fallback contract (falls back to `EN`, then to `[missing]<key>`,
// never throws) is exactly what makes this safe to ship incomplete: U1-U14
// each add the keys their own screen needs, the same way they add DOM nodes
// on top of this ticket's skeleton (O-27).
//
// ---------------------------------------------------------------------------
// Keys are English identifiers, never English phrases (§14.1)
// ---------------------------------------------------------------------------
// `hud.life`, not `"Life"` — a key is dotted `lowerCamelCase` segments, the
// first segment the namespace. Plural families use the CLDR suffixes
// `.one`/`.few`/`.many`/`.other`; only `common.free` needs one in this
// ticket's subset, and only `.one`/`.few`/`.many` of it were found in the
// range read (no `.other` row) — `pluralRule` below can still select
// `'other'` for an edge count (e.g. a fractional or very large n under a
// non-`ru`/`en` future locale); `t()`'s own missing-key fallback is what
// keeps that a `[missing]` string, not a throw.

export const EN = {
  // app, menu, slots
  'app.title': 'Claudo II',
  'app.subtitle': 'Lord of Instruction',
  'menu.continue': 'Continue',
  'menu.newCharacter': 'New Character',
  'menu.options': 'Options',
  'menu.credits': 'Credits',
  'menu.quit': 'Quit',
  'menu.resume': 'Resume',
  'menu.saveAndQuit': 'Save & Quit to Menu',
  'slot.empty': '— Empty Slot —',
  'slot.delete': 'Delete',
  'slot.export': 'Export',
  'slot.playTime': '{h}h {m}m',
  'slot.deleteConfirm': 'Delete {name} permanently?',
  'menu.seed': 'Seed {seed} · Build {build}',

  // character creation
  'create.title': 'Choose Your Discipline',
  'create.name': 'Name',
  'create.namePlaceholder': 'Enter a name',
  'create.begin': 'Begin',
  'create.back': 'Back',
  'create.resource': 'Resource',
  'create.attributes': 'Starting Attributes',
  'create.trees': 'Skill Trees',
  'create.startingItems': 'Starting Equipment',
  'create.nameTaken': 'That name is already used',
  'create.nameInvalid': "Letters, digits, spaces, apostrophes and hyphens",
  'class.ravager.name': 'Ravager',
  'class.emberwright.name': 'Emberwright',
  'class.runeblade.name': 'Runeblade',
  'class.ravager.tagline': 'Rage · Melee',
  'class.emberwright.tagline': 'Mana · Caster',
  'class.runeblade.tagline': 'Mana and Resonance · Hybrid',

  // HUD
  'hud.life': 'Life',
  'hud.mana': 'Mana',
  'hud.rage': 'Rage',
  'hud.resonance': 'Resonance',
  'hud.stamina': 'Stamina',
  'hud.level': 'Level',
  'hud.levelShort': 'Lv',
  'hud.gold': 'Gold',
  'hud.experience': 'Experience',
  'hud.xpProgress': '{cur} / {next} · {pct} %',
  'hud.maxLevel': 'Maximum Level',
  'hud.lifeRegen': 'Replenishes {v} per second',
  'hud.manaRegen': 'Regenerates {v} per second',
  'hud.rageDecay': 'Decays {v} per second out of combat',
  'hud.empty': 'Empty',
  'hud.cooldown': '{v} s',
  'hud.notEnoughMana': 'Not enough mana',
  'hud.notEnoughRage': 'Not enough rage',
  'hud.noResonance': 'No Resonance charges',
  'hud.northMark': 'N',
  'hud.zoneUnknown': 'Unknown',

  // panels and tabs
  'panel.inventory': 'Inventory',
  'panel.character': 'Character',
  'panel.skills': 'Skills',
  'panel.stash': 'Stash',
  'panel.vendor': 'Trade',
  'panel.quests': 'Quests',
  'panel.options': 'Paused',
  'panel.confirm': 'Confirm',
  'panel.close': 'Close',
  'tab.buy': 'Buy',
  'tab.sell': 'Sell',
  'tab.buyback': 'Buyback',
  'tab.repair': 'Repair',
  'tab.game': 'Game',
  'tab.video': 'Video',
  'tab.audio': 'Audio',
  'tab.controls': 'Controls',

  // common
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
  'common.revert': 'Revert',
  'common.discard': 'Discard',
  'common.undo': 'Undo',
  'common.sort': 'Sort',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.advanced': 'Advanced',
  'common.free.one': '{n} slot free',
  'common.free.few': '{n} slots free',
  'common.free.many': '{n} slots free',

  // inventory panel (UI-6, 09 §6)
  'inv.free': 'free',
  'toast.inventoryFull': 'Inventory is full',
  'toast.sorted': 'Sorted',
  'toast.notAvailable': 'Not available yet',

  // character sheet
  'sheet.attributes': 'Attributes',
  'sheet.points': 'Points: {n}',
  'sheet.strength': 'Strength',
  'sheet.dexterity': 'Dexterity',
  'sheet.vitality': 'Vitality',
  'sheet.energy': 'Energy',
  'sheet.damage': 'Damage',
  'sheet.attackRating': 'Attack Rating',
  'sheet.defence': 'Defence',
  'sheet.block': 'Chance to Block',
  'sheet.resistances': 'Resistances',
  'sheet.source.base': 'Base',
  'sheet.source.allocated': 'Allocated',
  'sheet.source.equipment': 'Equipment',
  'sheet.source.skills': 'Skills',
  'sheet.source.status': 'Effects',
  'sheet.source.difficulty': 'Difficulty',
  'slotName.head': 'Head',
  'slotName.chest': 'Chest',
  'slotName.hands': 'Hands',
  'slotName.legs': 'Legs',
  'slotName.mainHand': 'Main Hand',
  'slotName.offHand': 'Off Hand',
  'slotName.belt': 'Belt',
  'slotName.amulet': 'Amulet',
  'slotName.ring1': 'Ring',
  'slotName.ring2': 'Ring',

  // tooltip (representative sample — see this file's header)
  'tooltip.oneHandDamage': 'One-Hand Damage',
  'tooltip.twoHandDamage': 'Two-Hand Damage',
  'tooltip.attackSpeed': 'Attack Speed',
  'tooltip.reach': 'Reach',
  'tooltip.defence': 'Defence',
  'tooltip.blockChance': 'Chance to Block',
  'tooltip.durability': 'Durability',
  'tooltip.durabilityValue': '{cur} of {max}',
  'tooltip.durabilityLow': 'Nearly broken — repair it',
  'tooltip.durabilityBroken': 'Broken — grants nothing',
  'tooltip.requiredLevel': 'Required Level',
  'tooltip.requiredStrength': 'Required Strength',

  // tooltip (UI-5 — 09 §5)
  'tooltip.requiredDexterity': 'Required Dexterity',
  'tooltip.itemLevel': 'Item Level {v}',
  'tooltip.unidentified': 'Unidentified',
  'tooltip.unidentifiedHint': 'Use a Scroll of Identify',
  'tooltip.unusableEquipped': 'Requirements not met',
  'tooltip.sockets': 'Sockets {v}',
  'tooltip.movement': 'Movement −{v} %',
  'tooltip.quantity': 'Quantity',
  'tooltip.restoresInstant': 'Restores {pct} % {resource} instantly',
  'tooltip.restoresOverTime': 'Restores {pct} % {resource} over {sec} s',

  // tooltip (UI-7 — 09 §5.6 comparison mode)
  'tooltip.equipped': 'Equipped',
  'tooltip.twoHandWarning': 'Equipping this two-handed weapon will also unequip your shield',
  'tooltip.compareBasis': 'Weapon damage compares as the average of its range; defence compares after % bonuses',
  'tooltip.compareNew': 'new',
  'tooltip.compareLost': 'lost',

  // rarity words (09 §5.1 block 3)
  'rarity.normal': 'Normal',
  'rarity.superior': 'Superior',
  'rarity.magic': 'Magic',
  'rarity.rare': 'Rare',
  'rarity.unique': 'Unique',

  // attack-speed words (09 §5.2)
  'speed.veryFast': 'Very Fast',
  'speed.fast': 'Fast',
  'speed.normal': 'Normal',
  'speed.slow': 'Slow',
  'speed.verySlow': 'Very Slow',

  // skill tree name(s) — only what the §5.1 worked example names; the rest
  // of the tree catalogue belongs to whichever ticket lands `src/skills/`.
  'tree.carnage': 'Carnage',

  // rolled-property stat line templates (09 §5.3.2), i18n key `stat.<id>`.
  // Pair-merged and resistance-merged lines use a synthetic key (no single
  // StatBlock identifier names them) rather than a real stat id.
  'stat.skillBonusAll': '+{v} to All Skills',
  'stat.skillBonusTree': '+{v} to {tree} Skills',
  'stat.skillBonusSkill': '+{v} to {skill}',
  'stat.increasedAttackSpeed': '+{v} % Increased Attack Speed',
  'stat.fasterCastRate': '+{v} % Faster Cast Rate',
  'stat.fasterHitRecovery': '+{v} % Faster Hit Recovery',
  'stat.enhancedDamage': '+{v} % Enhanced Damage',
  'stat.damageRange': 'Adds {a} – {b} Damage',
  'stat.fireRange': 'Adds {a} – {b} Fire Damage',
  'stat.coldRange': 'Adds {a} – {b} Cold Damage',
  'stat.lightRange': 'Adds {a} – {b} Lightning Damage',
  'stat.poisonRange': 'Adds {a} – {b} Poison Damage over {d} s',
  'stat.magicRange': 'Adds {a} – {b} Magic Damage',
  'stat.fireDamagePercent': '+{v} % Fire Damage',
  'stat.coldDamagePercent': '+{v} % Cold Damage',
  'stat.lightDamagePercent': '+{v} % Lightning Damage',
  'stat.poisonDamagePercent': '+{v} % Poison Damage',
  'stat.magicDamagePercent': '+{v} % Magic Damage',
  'stat.elementalDamagePercent': '+{v} % Elemental Damage',
  'stat.physicalDamagePercent': '+{v} % Physical Damage',
  'stat.fireResistPierce': '−{v} to Enemy Fire Resistance',
  'stat.coldResistPierce': '−{v} to Enemy Cold Resistance',
  'stat.lightResistPierce': '−{v} to Enemy Lightning Resistance',
  'stat.poisonResistPierce': '−{v} to Enemy Poison Resistance',
  'stat.coldDuration': '+{v} s Chill Duration',
  'stat.poisonDuration': '+{v} s Poison Duration',
  'stat.attackRating': '+{v} to Attack Rating',
  'stat.attackRatingPercent': '+{v} % Attack Rating',
  'stat.critChance': '+{v} % Chance of Deadly Strike',
  'stat.critMult': '+{v} % Deadly Strike Damage',
  'stat.pierceChance': '{v} % Piercing Attack',
  'stat.knockbackChance': '{v} % Chance of Knockback',
  'stat.lifeSteal': '{v} % of Physical Damage Stolen as Life',
  'stat.manaSteal': '{v} % of Physical Damage Stolen as Mana',
  'stat.lifeOnHit': '+{v} Life after each Hit',
  'stat.manaOnHit': '+{v} Mana after each Hit',
  'stat.lifeOnKill': '+{v} Life after each Kill',
  'stat.manaOnKill': '+{v} Mana after each Kill',
  'stat.manaReturnPercent': '{v} % of Physical Damage Returned as Mana',
  'stat.rageOnHit': '+{v} Rage per Hit',
  'stat.rageOnTakeHit': '+{v} Rage when Struck',
  'stat.resonanceOnHit': '+{v} Resonance per Hit',
  'stat.thorns': 'Attacker takes {v} Damage',
  'stat.defense': '+{v} Defence',
  'stat.defensePercent': '+{v} % Enhanced Defence',
  'stat.blockChance': '+{v} % Chance to Block',
  'stat.dodgeChance': '+{v} % Chance to Dodge',
  'stat.fireResist': 'Fire Resistance +{v} %',
  'stat.coldResist': 'Cold Resistance +{v} %',
  'stat.lightResist': 'Lightning Resistance +{v} %',
  'stat.poisonResist': 'Poison Resistance +{v} %',
  'stat.magicResist': 'Magic Resistance +{v} %',
  'stat.physicalResist': 'Physical Resistance +{v} %',
  'stat.allResistances': 'All Resistances +{v} %',
  'stat.elementalResistances': 'Elemental Resistances +{v} %',
  'stat.maxFireResist': '+{v} % to Maximum Fire Resistance',
  'stat.maxColdResist': '+{v} % to Maximum Cold Resistance',
  'stat.maxLightResist': '+{v} % to Maximum Lightning Resistance',
  'stat.maxPoisonResist': '+{v} % to Maximum Poison Resistance',
  'stat.maxMagicResist': '+{v} % to Maximum Magic Resistance',
  'stat.maxPhysicalResist': '+{v} % to Maximum Physical Resistance',
  'stat.damageReduceFlat': 'Physical Damage Taken Reduced by {v}',
  'stat.damageReducePercent': 'Physical Damage Taken Reduced by {v} %',
  'stat.magicDamageReduceFlat': 'Magic Damage Taken Reduced by {v}',
  'stat.ccReduction': '{v} % Reduced Control Duration',
  'stat.cannotBeFrozen': 'Cannot Be Frozen',
  'stat.maxLife': '+{v} to Life',
  'stat.lifePercent': '+{v} % to Life',
  'statNeg.lifePercent': '−{v} % to Life',
  'stat.maxMana': '+{v} to Mana',
  'stat.manaPercent': '+{v} % to Mana',
  'stat.maxRage': '+{v} to Maximum Rage',
  'stat.maxResonance': '+{v} to Maximum Resonance',
  'stat.lifeRegen': 'Replenish Life +{v} /s',
  'stat.lifeRegenPercent': 'Replenish Life +{v} % /s',
  'stat.manaRegen': 'Regenerate Mana +{v} /s',
  'stat.manaRegenPercent': 'Regenerate Mana +{v} % /s',
  'stat.movementSpeed': '+{v} % Faster Run',
  'stat.magicFind': '+{v} % Better Chance of Magic Items',
  'stat.goldFind': '+{v} % Extra Gold from Monsters',
  'stat.experienceGain': '+{v} % Experience Gained',
  'stat.manaCostReduction': '−{v} % Mana Cost of Skills',
  'stat.requirementReduction': 'Requirements −{v} %',
  'stat.lightRadius': '+{v} m Light Radius',
  'stat.damageTakenToMana': '{v} % Damage Taken Goes to Mana',

  // prompts
  'prompt.openChest': 'Open',
  'prompt.pickUp': 'Pick Up',

  // death, options, controls
  'death.title': 'You Have Fallen',
  'death.slainBy': 'Slain by {name}',
  'death.xpLost': 'Experience lost {pct} % ({v})',
  'death.noPenalty': 'No experience is lost before level 5',
  'death.itemsKept': 'Your possessions remain with you.',
  'death.return': 'Return to Last Bastion',
  'options.quality': 'Quality',
  'options.quality.low': 'Low',
  'options.quality.medium': 'Medium',
  'options.quality.high': 'High',
  'options.quality.ultra': 'Ultra',
  'options.resolutionScale': 'Resolution Scale',
  'options.damageNumbers': 'Damage Numbers',
  'options.damageNumbers.off': 'Off',
  'options.damageNumbers.own': 'Mine',
  'options.damageNumbers.all': 'All',
  'options.lootLabels': 'Loot Labels',
  'options.lootLabels.alt': 'Hold Alt',
  'options.lootLabels.always': 'Always',
  'options.colourBlind': 'Colour-Blind Mode',
  'options.colourBlind.off': 'Off',
  'options.colourBlind.protan': 'Protanopia',
  'options.colourBlind.deutan': 'Deuteranopia',
  'options.colourBlind.tritan': 'Tritanopia',
  'options.rarityWords': 'Rarity Words',
  'options.alwaysCompare': 'Always Compare',
  'options.uiScale': 'Interface Scale',
  'options.uiScaleUnavailable': 'Not available at this resolution',
  'options.minimapOpacity': 'Minimap Opacity',
  'options.reduceShake': 'Reduce Camera Shake',
  'options.language': 'Language',
  'options.masterVolume': 'Master Volume',
  'options.sfxVolume': 'Effects',
  'options.musicVolume': 'Music',
  'options.difficulty': 'Difficulty',
  'difficulty.instruction': 'Instruction',
  'difficulty.trial': 'Trial',
  'difficulty.renunciation': 'Renunciation',
  'controls.title': 'Controls',
  'controls.pressKey': 'Press a key…',
  'controls.unbound': 'Unbound',
  'controls.reserved': 'That key is reserved',
  'controls.resetDefaults': 'Reset to Defaults',

  // actions
  'action.move_attack': 'Move / Attack',
  'action.cast_selected': 'Cast Selected Skill',
  'action.hotbar_1': 'Skill 1',
  'action.belt_1': 'Belt 1',
  'action.toggle_map': 'Map',
  'action.show_loot': 'Show Loot',
  'action.toggle_inventory': 'Inventory',
  'action.toggle_character': 'Character',
  'action.toggle_skills': 'Skills',
  'action.toggle_quests': 'Quests',
  'action.stop': 'Stop',
  'action.toggle_hud': 'Hide Interface',
  'action.pause': 'Pause',

  // combat floating-text words (O-70) — 09 §10.1's four text-only kinds
  // (`feedback.js`, UI-4, calls `this._t('combat.<kind>')` honestly for
  // each and got the safe `[missing]` fallback until this repair).
  'combat.immune': 'Immune',
  'combat.miss': 'Miss',
  'combat.block': 'Block',
  'combat.absorb': 'Absorb',

  // errors
  'error.saveCorrupt': 'This character could not be read and has been set aside.',
  'error.saveNewer': 'This save was made by a newer version of the game.',
  'error.storageFull': 'Browser storage is full — free space or export a character.',
  'error.webgl': 'This browser cannot run WebGL 2.',
};

export const RU = {
  'app.title': 'Claudo II',
  'app.subtitle': 'Владыка Наставления',
  'menu.continue': 'Продолжить',
  'menu.newCharacter': 'Новый персонаж',
  'menu.options': 'Настройки',
  'menu.credits': 'Авторы',
  'menu.quit': 'Выход',
  'menu.resume': 'Вернуться в игру',
  'menu.saveAndQuit': 'Сохранить и выйти в меню',
  'slot.empty': '— Пустой слот —',
  'slot.delete': 'Удалить',
  'slot.export': 'Экспорт',
  'slot.playTime': '{h} ч {m} мин',
  'slot.deleteConfirm': 'Удалить {name} безвозвратно?',
  'menu.seed': 'Сид {seed} · Сборка {build}',

  'create.title': 'Выберите путь',
  'create.name': 'Имя',
  'create.namePlaceholder': 'Введите имя',
  'create.begin': 'Начать',
  'create.back': 'Назад',
  'create.resource': 'Ресурс',
  'create.attributes': 'Начальные характеристики',
  'create.trees': 'Ветви навыков',
  'create.startingItems': 'Начальное снаряжение',
  'create.nameTaken': 'Это имя уже занято',
  'create.nameInvalid': 'Буквы, цифры, пробел, апостроф и дефис',
  'class.ravager.name': 'Разоритель',
  'class.emberwright.name': 'Пепельник',
  'class.runeblade.name': 'Рунный клинок',
  'class.ravager.tagline': 'Ярость · Ближний бой',
  'class.emberwright.tagline': 'Мана · Заклинатель',
  'class.runeblade.tagline': 'Мана и Резонанс · Гибрид',

  'hud.life': 'Жизнь',
  'hud.mana': 'Мана',
  'hud.rage': 'Ярость',
  'hud.resonance': 'Резонанс',
  'hud.stamina': 'Выносливость',
  'hud.level': 'Уровень',
  'hud.levelShort': 'Ур',
  'hud.gold': 'Золото',
  'hud.experience': 'Опыт',
  'hud.xpProgress': '{cur} / {next} · {pct} %',
  'hud.maxLevel': 'Максимальный уровень',
  'hud.lifeRegen': 'Восстанавливает {v} в секунду',
  'hud.manaRegen': 'Восстанавливает {v} в секунду',
  'hud.rageDecay': 'Утекает на {v} в секунду вне боя',
  'hud.empty': 'Пусто',
  'hud.cooldown': '{v} с',
  'hud.notEnoughMana': 'Недостаточно маны',
  'hud.notEnoughRage': 'Недостаточно ярости',
  'hud.noResonance': 'Нет зарядов Резонанса',
  'hud.northMark': 'С',
  'hud.zoneUnknown': 'Неизвестно',

  'panel.inventory': 'Инвентарь',
  'panel.character': 'Персонаж',
  'panel.skills': 'Навыки',
  'panel.stash': 'Сундук',
  'panel.vendor': 'Торговля',
  'panel.quests': 'Задания',
  'panel.options': 'Пауза',
  'panel.confirm': 'Подтверждение',
  'panel.close': 'Закрыть',
  'tab.buy': 'Купить',
  'tab.sell': 'Продать',
  'tab.buyback': 'Выкуп',
  'tab.repair': 'Ремонт',
  'tab.game': 'Игра',
  'tab.video': 'Графика',
  'tab.audio': 'Звук',
  'tab.controls': 'Управление',

  'common.confirm': 'Подтвердить',
  'common.cancel': 'Отмена',
  'common.revert': 'Откатить',
  'common.discard': 'Отбросить',
  'common.undo': 'Вернуть',
  'common.sort': 'Сортировать',
  'common.yes': 'Да',
  'common.no': 'Нет',
  'common.advanced': 'Подробно',
  'common.free.one': 'Свободна {n} ячейка',
  'common.free.few': 'Свободно {n} ячейки',
  'common.free.many': 'Свободно {n} ячеек',

  'inv.free': 'свободно',
  'toast.inventoryFull': 'Инвентарь полон',
  'toast.sorted': 'Отсортировано',
  'toast.notAvailable': 'Пока недоступно',

  'sheet.attributes': 'Характеристики',
  'sheet.points': 'Очков: {n}',
  'sheet.strength': 'Сила',
  'sheet.dexterity': 'Ловкость',
  'sheet.vitality': 'Живучесть',
  'sheet.energy': 'Энергия',
  'sheet.damage': 'Урон',
  'sheet.attackRating': 'Меткость',
  'sheet.defence': 'Защита',
  'sheet.block': 'Шанс блока',
  'sheet.resistances': 'Сопротивления',
  'sheet.source.base': 'База',
  'sheet.source.allocated': 'Вложено',
  'sheet.source.equipment': 'Снаряжение',
  'sheet.source.skills': 'Навыки',
  'sheet.source.status': 'Эффекты',
  'sheet.source.difficulty': 'Сложность',
  'slotName.head': 'Голова',
  'slotName.chest': 'Торс',
  'slotName.hands': 'Руки',
  'slotName.legs': 'Ноги',
  'slotName.mainHand': 'Оружие',
  'slotName.offHand': 'Левая рука',
  'slotName.belt': 'Пояс',
  'slotName.amulet': 'Амулет',
  'slotName.ring1': 'Кольцо',
  'slotName.ring2': 'Кольцо',

  'tooltip.oneHandDamage': 'Урон одноручного',
  'tooltip.twoHandDamage': 'Урон двуручного',
  'tooltip.attackSpeed': 'Скорость атаки',
  'tooltip.reach': 'Досягаемость',
  'tooltip.defence': 'Защита',
  'tooltip.blockChance': 'Шанс блока',
  'tooltip.durability': 'Прочность',
  'tooltip.durabilityValue': '{cur} из {max}',
  'tooltip.durabilityLow': 'Почти сломано — почините',
  'tooltip.durabilityBroken': 'Сломано — не даёт бонусов',
  'tooltip.requiredLevel': 'Требуется уровень',
  'tooltip.requiredStrength': 'Требуется сила',

  'tooltip.requiredDexterity': 'Требуется ловкость',
  'tooltip.itemLevel': 'Уровень предмета {v}',
  'tooltip.unidentified': 'Неопознано',
  'tooltip.unidentifiedHint': 'Используйте свиток опознания',
  'tooltip.unusableEquipped': 'Требования не выполнены',
  'tooltip.sockets': 'Гнёзда {v}',
  'tooltip.movement': 'Передвижение −{v} %',
  'tooltip.quantity': 'Количество',
  'tooltip.restoresInstant': 'Восстанавливает {pct} % {resource} мгновенно',
  'tooltip.restoresOverTime': 'Восстанавливает {pct} % {resource} за {sec} с',

  'tooltip.equipped': 'Экипировано',
  'tooltip.twoHandWarning': 'Экипировка этого двуручного оружия также снимет ваш щит',
  'tooltip.compareBasis': 'Урон оружия сравнивается по среднему значению диапазона; защита — после учёта бонусов в %',
  'tooltip.compareNew': 'новое',
  'tooltip.compareLost': 'потеряно',

  'rarity.normal': 'Обычное',
  'rarity.superior': 'Превосходное',
  'rarity.magic': 'Магическое',
  'rarity.rare': 'Редкое',
  'rarity.unique': 'Уникальное',

  'speed.veryFast': 'Очень быстро',
  'speed.fast': 'Быстро',
  'speed.normal': 'Обычно',
  'speed.slow': 'Медленно',
  'speed.verySlow': 'Очень медленно',

  'tree.carnage': 'Резня',

  'stat.skillBonusAll': '+{v} ко всем навыкам',
  'stat.skillBonusTree': '+{v} к навыкам «{tree}»',
  'stat.skillBonusSkill': '+{v} к навыку «{skill}»',
  'stat.increasedAttackSpeed': '+{v} % к скорости атаки',
  'stat.fasterCastRate': '+{v} % к скорости каста',
  'stat.fasterHitRecovery': '+{v} % к скорости восстановления',
  'stat.enhancedDamage': '+{v} % к урону',
  'stat.damageRange': 'Добавляет {a} – {b} урона',
  'stat.fireRange': 'Добавляет {a} – {b} урона огнём',
  'stat.coldRange': 'Добавляет {a} – {b} урона холодом',
  'stat.lightRange': 'Добавляет {a} – {b} урона молнией',
  'stat.poisonRange': 'Добавляет {a} – {b} урона ядом за {d} с',
  'stat.magicRange': 'Добавляет {a} – {b} магического урона',
  'stat.fireDamagePercent': '+{v} % урона огнём',
  'stat.coldDamagePercent': '+{v} % урона холодом',
  'stat.lightDamagePercent': '+{v} % урона молнией',
  'stat.poisonDamagePercent': '+{v} % урона ядом',
  'stat.magicDamagePercent': '+{v} % магического урона',
  'stat.elementalDamagePercent': '+{v} % урона стихиями',
  'stat.physicalDamagePercent': '+{v} % физического урона',
  'stat.fireResistPierce': '−{v} к сопротивлению огню врага',
  'stat.coldResistPierce': '−{v} к сопротивлению холоду врага',
  'stat.lightResistPierce': '−{v} к сопротивлению молнии врага',
  'stat.poisonResistPierce': '−{v} к сопротивлению яду врага',
  'stat.coldDuration': '+{v} с к длительности охлаждения',
  'stat.poisonDuration': '+{v} с к длительности яда',
  'stat.attackRating': '+{v} к меткости',
  'stat.attackRatingPercent': '+{v} % к меткости',
  'stat.critChance': '+{v} % шанс смертельного удара',
  'stat.critMult': '+{v} % урона смертельного удара',
  'stat.pierceChance': '{v} % пробивающая атака',
  'stat.knockbackChance': '{v} % шанс отбрасывания',
  'stat.lifeSteal': '{v} % физ. урона похищается как жизнь',
  'stat.manaSteal': '{v} % физ. урона похищается как мана',
  'stat.lifeOnHit': '+{v} жизни за каждый удар',
  'stat.manaOnHit': '+{v} маны за каждый удар',
  'stat.lifeOnKill': '+{v} жизни за каждое убийство',
  'stat.manaOnKill': '+{v} маны за каждое убийство',
  'stat.manaReturnPercent': '{v} % физ. урона возвращается как мана',
  'stat.rageOnHit': '+{v} ярости за удар',
  'stat.rageOnTakeHit': '+{v} ярости при получении удара',
  'stat.resonanceOnHit': '+{v} резонанса за удар',
  'stat.thorns': 'Атакующий получает {v} урона',
  'stat.defense': '+{v} к защите',
  'stat.defensePercent': '+{v} % к защите',
  'stat.blockChance': '+{v} % к шансу блока',
  'stat.dodgeChance': '+{v} % к шансу уклонения',
  'stat.fireResist': 'Сопротивление огню +{v} %',
  'stat.coldResist': 'Сопротивление холоду +{v} %',
  'stat.lightResist': 'Сопротивление молнии +{v} %',
  'stat.poisonResist': 'Сопротивление яду +{v} %',
  'stat.magicResist': 'Сопротивление магии +{v} %',
  'stat.physicalResist': 'Сопротивление физическому урону +{v} %',
  'stat.allResistances': 'Все сопротивления +{v} %',
  'stat.elementalResistances': 'Стихийные сопротивления +{v} %',
  'stat.maxFireResist': '+{v} % к максимуму сопр. огню',
  'stat.maxColdResist': '+{v} % к максимуму сопр. холоду',
  'stat.maxLightResist': '+{v} % к максимуму сопр. молнии',
  'stat.maxPoisonResist': '+{v} % к максимуму сопр. яду',
  'stat.maxMagicResist': '+{v} % к максимуму сопр. магии',
  'stat.maxPhysicalResist': '+{v} % к максимуму сопр. физ. урону',
  'stat.damageReduceFlat': 'Получаемый физ. урон снижен на {v}',
  'stat.damageReducePercent': 'Получаемый физ. урон снижен на {v} %',
  'stat.magicDamageReduceFlat': 'Получаемый магический урон снижен на {v}',
  'stat.ccReduction': '{v} % к снижению контроля',
  'stat.cannotBeFrozen': 'Не подвержен заморозке',
  'stat.maxLife': '+{v} к жизни',
  'stat.lifePercent': '+{v} % к жизни',
  'statNeg.lifePercent': '−{v} % к жизни',
  'stat.maxMana': '+{v} к мане',
  'stat.manaPercent': '+{v} % к мане',
  'stat.maxRage': '+{v} к максимуму ярости',
  'stat.maxResonance': '+{v} к максимуму резонанса',
  'stat.lifeRegen': 'Восстановление жизни +{v} /с',
  'stat.lifeRegenPercent': 'Восстановление жизни +{v} % /с',
  'stat.manaRegen': 'Восстановление маны +{v} /с',
  'stat.manaRegenPercent': 'Восстановление маны +{v} % /с',
  'stat.movementSpeed': '+{v} % к скорости бега',
  'stat.magicFind': '+{v} % к шансу магических предметов',
  'stat.goldFind': '+{v} % к золоту с монстров',
  'stat.experienceGain': '+{v} % к получаемому опыту',
  'stat.manaCostReduction': '−{v} % к стоимости навыков',
  'stat.requirementReduction': 'Требования −{v} %',
  'stat.lightRadius': '+{v} м к радиусу света',
  'stat.damageTakenToMana': '{v} % получаемого урона уходит в ману',

  'prompt.openChest': 'Открыть',
  'prompt.pickUp': 'Подобрать',

  'death.title': 'Вы пали',
  'death.slainBy': 'Убиты: {name}',
  'death.xpLost': 'Потеряно опыта {pct} % ({v})',
  'death.noPenalty': 'До 5 уровня опыт не теряется',
  'death.itemsKept': 'Ваши вещи остаются при вас.',
  'death.return': 'Вернуться в Последний Оплот',
  'options.quality': 'Качество',
  'options.quality.low': 'Низкое',
  'options.quality.medium': 'Среднее',
  'options.quality.high': 'Высокое',
  'options.quality.ultra': 'Ультра',
  'options.resolutionScale': 'Масштаб рендера',
  'options.damageNumbers': 'Числа урона',
  'options.damageNumbers.off': 'Выкл.',
  'options.damageNumbers.own': 'Только мои',
  'options.damageNumbers.all': 'Все',
  'options.lootLabels': 'Метки лута',
  'options.lootLabels.alt': 'По Alt',
  'options.lootLabels.always': 'Всегда',
  'options.colourBlind': 'Режим для дальтоников',
  'options.colourBlind.off': 'Выкл.',
  'options.colourBlind.protan': 'Протанопия',
  'options.colourBlind.deutan': 'Дейтеранопия',
  'options.colourBlind.tritan': 'Тританопия',
  'options.rarityWords': 'Подписи редкости',
  'options.alwaysCompare': 'Всегда сравнивать',
  'options.uiScale': 'Масштаб интерфейса',
  'options.uiScaleUnavailable': 'Недоступно при этом разрешении',
  'options.minimapOpacity': 'Прозрачность карты',
  'options.reduceShake': 'Меньше тряски камеры',
  'options.language': 'Язык',
  'options.masterVolume': 'Общая громкость',
  'options.sfxVolume': 'Эффекты',
  'options.musicVolume': 'Музыка',
  'options.difficulty': 'Сложность',
  'difficulty.instruction': 'Наставление',
  'difficulty.trial': 'Испытание',
  'difficulty.renunciation': 'Отречение',
  'controls.title': 'Управление',
  'controls.pressKey': 'Нажмите клавишу…',
  'controls.unbound': 'Не назначено',
  'controls.reserved': 'Эта клавиша зарезервирована',
  'controls.resetDefaults': 'Сбросить настройки',

  'action.move_attack': 'Идти / Атаковать',
  'action.cast_selected': 'Применить выбранный навык',
  'action.hotbar_1': 'Навык 1',
  'action.belt_1': 'Пояс 1',
  'action.toggle_map': 'Карта',
  'action.show_loot': 'Показать лут',
  'action.toggle_inventory': 'Инвентарь',
  'action.toggle_character': 'Персонаж',
  'action.toggle_skills': 'Навыки',
  'action.toggle_quests': 'Задания',
  'action.stop': 'Остановиться',
  'action.toggle_hud': 'Скрыть интерфейс',
  'action.pause': 'Пауза',

  'combat.immune': 'Иммунитет',
  'combat.miss': 'Мимо',
  'combat.block': 'Блок',
  'combat.absorb': 'Поглощено',

  'error.saveCorrupt': 'Этого персонажа не удалось прочитать; сейв отложен.',
  'error.saveNewer': 'Сохранение сделано более новой версией игры.',
  'error.storageFull': 'Хранилище браузера заполнено — освободите место или экспортируйте персонажа.',
  'error.webgl': 'Этот браузер не поддерживает WebGL 2.',
};

/** `{ en: EN, ru: RU }` — the only two locales `09 §14` names. */
export const DICTIONARIES = { en: EN, ru: RU };

/**
 * CLDR plural category for `n` in `lang`. Russian needs all four
 * (`one`/`few`/`many`/`other`); English needs two (`one`/`other`) — `09
 * §14.1`. Standard CLDR rules (not spelled out verbatim in the range of
 * `09-ui.md` this ticket read — see this ticket's report).
 * @param {'en'|'ru'} lang
 * @param {number} n
 * @returns {'one'|'few'|'many'|'other'}
 */
export function pluralRule(lang, n) {
  const abs = Math.abs(n);
  if (lang === 'ru') {
    const mod10 = abs % 10;
    const mod100 = abs % 100;
    if (!Number.isInteger(abs)) return 'other';
    if (mod10 === 1 && mod100 !== 11) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'few';
    if (mod10 === 0 || (mod10 >= 5 && mod10 <= 9) || (mod100 >= 11 && mod100 <= 14)) return 'many';
    return 'other';
  }
  return abs === 1 ? 'one' : 'other';
}

/**
 * Single-pass `{name}` placeholder substitution — `09 §14.1`: "a single
 * pass over the string." Allocates (string ops always do); the ≤ 8-key
 * preallocated-buffer path `§14.1` describes for per-frame callers is not
 * needed by anything in this ticket (nothing draws at U0) and is left for
 * whichever U1+ ticket first calls `t()` from `lateUpdate` every frame.
 * @param {string} str
 * @param {object} [params]
 * @returns {string}
 */
export function format(str, params) {
  if (!params) return str;
  let out = str;
  for (const key in params) {
    if (out.indexOf('{' + key + '}') === -1) continue;
    out = out.split('{' + key + '}').join(String(params[key]));
  }
  return out;
}

/**
 * `09 §14.1`'s boot-time dev check: keys `EN` has that `RU` doesn't, minus
 * `allowlist`. Run once at init, never per frame.
 * @param {Set<string>} [allowlist]
 * @returns {string[]}
 */
export function missingRuKeys(allowlist) {
  const skip = allowlist || new Set();
  const missing = [];
  for (const key in EN) {
    if (!(key in RU) && !skip.has(key)) missing.push(key);
  }
  return missing;
}
