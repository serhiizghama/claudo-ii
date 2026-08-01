// src/items/data/names.js
//
// ITEM-8 — the rare-name pools. `13-progression-lore.md` §10.5 is the
// binding source (PROGRESS D-25): `04-items.md` §3.2-§3.5 (the 44-head/
// 48-tail/20-epithet pools, the three-word `affixCount >= 5` branch) is
// SUPERSEDED and was not transcribed here. See `src/items/names.js`'s file
// header for the full ruling and the corrected D13 draw-consumption rule.
//
// Plain frozen data, no logic (`ARCHITECTURE.md` rule 9 / this ticket's
// brief rule 6): `tools/lootsim.mjs` must be able to generate 200 000 names
// in Node without loading a dictionary. That is also why BOTH the English
// and Russian display strings live here, not split off into
// `src/ui/i18n.js` under `name.*` the way `13` §10.1 literally proposes —
// Ruling A of this ticket's brief, a deliberate, recorded deviation:
//   - `01-data-model.md` §5.3 types `ItemInstance.nameOverride` as a STRING
//     ("rare items store their generated two-word name here"), not a pair
//     of indices — something headless has to be able to produce a string,
//     and `src/items/` may not import `src/ui/i18n.js` (`ARCHITECTURE.md`
//     hard rule 2: no cross-subsystem import; `ui` depends on `items`, not
//     the other way around).
//   - `13` §10.1's own stated reason for the split — "`tools/lootsim.mjs`
//     must be able to generate 200 000 names in Node without loading a
//     dictionary" — is satisfied directly by putting the words here, and
//     defeated by putting them in `src/ui/i18n.js`.
//   - `13` §10.5 authors the EN and RU columns in one table; splitting them
//     across two subsystems' directories is the duplicated-constant drift
//     this project has already been bitten by twice (O-51, O-48).
//
// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------
// `RARE_HEAD[i]` = `{ en, ru, g }` — nominative case; `g` is the Russian
//   gender tag (`'m'|'f'|'n'`, rule G1, `13` §10.4), index-aligned to `13`
//   §10.5's head row `#(i+1)` (`name.rare.head.<i+1>`).
// `RARE_TAIL[i]` = `{ en, ru, def }` — Russian is PRE-INFLECTED GENITIVE
//   (rule G3, `13` §10.4: a genitive noun agrees with nothing, so plain
//   concatenation after any head is already correct). `def` is `true` for
//   exactly the English tails the `13` §10.5 table marks `✔` ("of the ..."
//   construction); `en` for those already includes the leading "the" (e.g.
//   "the Instructor"), so the composer (`src/items/names.js`) only ever
//   inserts the literal string `' of '` between head and tail — it never
//   inspects `en` itself. Index-aligned to `13` §10.5's tail row `#(i+1)`.
//
// 56 heads x 48 tails = 2 688 combinations (`13` §10.3).

export const RARE_HEAD = Object.freeze([
  Object.freeze({ en: 'Ash', ru: 'Пепел', g: 'm' }), // 1
  Object.freeze({ en: 'Bone', ru: 'Кость', g: 'f' }), // 2
  Object.freeze({ en: 'Ember', ru: 'Уголь', g: 'm' }), // 3
  Object.freeze({ en: 'Cinder', ru: 'Головня', g: 'f' }), // 4
  Object.freeze({ en: 'Word', ru: 'Слово', g: 'n' }), // 5
  Object.freeze({ en: 'Silence', ru: 'Тишина', g: 'f' }), // 6
  Object.freeze({ en: 'Doom', ru: 'Погибель', g: 'f' }), // 7
  Object.freeze({ en: 'Ruin', ru: 'Разор', g: 'm' }), // 8
  Object.freeze({ en: 'Grief', ru: 'Скорбь', g: 'f' }), // 9
  Object.freeze({ en: 'Dusk', ru: 'Сумрак', g: 'm' }), // 10
  Object.freeze({ en: 'Iron', ru: 'Железо', g: 'n' }), // 11
  Object.freeze({ en: 'Fang', ru: 'Клык', g: 'm' }), // 12
  Object.freeze({ en: 'Claw', ru: 'Коготь', g: 'm' }), // 13
  Object.freeze({ en: 'Sigh', ru: 'Вздох', g: 'm' }), // 14
  Object.freeze({ en: 'Whisper', ru: 'Шёпот', g: 'm' }), // 15
  Object.freeze({ en: 'Oath', ru: 'Клятва', g: 'f' }), // 16
  Object.freeze({ en: 'Vow', ru: 'Обет', g: 'm' }), // 17
  Object.freeze({ en: 'Scar', ru: 'Рубец', g: 'm' }), // 18
  Object.freeze({ en: 'Wound', ru: 'Рана', g: 'f' }), // 19
  Object.freeze({ en: 'Thorn', ru: 'Шип', g: 'm' }), // 20
  Object.freeze({ en: 'Shard', ru: 'Осколок', g: 'm' }), // 21
  Object.freeze({ en: 'Splinter', ru: 'Заноза', g: 'f' }), // 22
  Object.freeze({ en: 'Hollow', ru: 'Пустота', g: 'f' }), // 23
  Object.freeze({ en: 'Husk', ru: 'Оболочка', g: 'f' }), // 24
  Object.freeze({ en: 'Cage', ru: 'Клеть', g: 'f' }), // 25
  Object.freeze({ en: 'Chain', ru: 'Цепь', g: 'f' }), // 26
  Object.freeze({ en: 'Nail', ru: 'Гвоздь', g: 'm' }), // 27
  Object.freeze({ en: 'Wedge', ru: 'Клин', g: 'm' }), // 28
  Object.freeze({ en: 'Verse', ru: 'Стих', g: 'm' }), // 29
  Object.freeze({ en: 'Line', ru: 'Строка', g: 'f' }), // 30
  Object.freeze({ en: 'Page', ru: 'Страница', g: 'f' }), // 31
  Object.freeze({ en: 'Mark', ru: 'Метка', g: 'f' }), // 32
  Object.freeze({ en: 'Brand', ru: 'Клеймо', g: 'n' }), // 33
  Object.freeze({ en: 'Seal', ru: 'Печать', g: 'f' }), // 34
  Object.freeze({ en: 'Key', ru: 'Ключ', g: 'm' }), // 35
  Object.freeze({ en: 'Lock', ru: 'Замок', g: 'm' }), // 36
  Object.freeze({ en: 'Bar', ru: 'Затвор', g: 'm' }), // 37
  Object.freeze({ en: 'Lantern', ru: 'Фонарь', g: 'm' }), // 38
  Object.freeze({ en: 'Wick', ru: 'Фитиль', g: 'm' }), // 39
  Object.freeze({ en: 'Smoke', ru: 'Дым', g: 'm' }), // 40
  Object.freeze({ en: 'Soot', ru: 'Сажа', g: 'f' }), // 41
  Object.freeze({ en: 'Slag', ru: 'Шлак', g: 'm' }), // 42
  Object.freeze({ en: 'Rust', ru: 'Ржавчина', g: 'f' }), // 43
  Object.freeze({ en: 'Frost', ru: 'Иней', g: 'm' }), // 44
  Object.freeze({ en: 'Storm', ru: 'Буря', g: 'f' }), // 45
  Object.freeze({ en: 'Gale', ru: 'Вихрь', g: 'm' }), // 46
  Object.freeze({ en: 'Tide', ru: 'Прилив', g: 'm' }), // 47
  Object.freeze({ en: 'Trace', ru: 'След', g: 'm' }), // 48
  Object.freeze({ en: 'Echo', ru: 'Эхо', g: 'n' }), // 49
  Object.freeze({ en: 'Tremor', ru: 'Дрожь', g: 'f' }), // 50
  Object.freeze({ en: 'Toll', ru: 'Набат', g: 'm' }), // 51
  Object.freeze({ en: 'Knell', ru: 'Звон', g: 'm' }), // 52
  Object.freeze({ en: 'Dirge', ru: 'Плач', g: 'm' }), // 53
  Object.freeze({ en: 'Lesson', ru: 'Урок', g: 'm' }), // 54
  Object.freeze({ en: 'Charge', ru: 'Наказ', g: 'm' }), // 55
  Object.freeze({ en: 'Reckoning', ru: 'Расплата', g: 'f' }), // 56
]);

export const RARE_TAIL = Object.freeze([
  Object.freeze({ en: 'Ash', ru: 'Праха', def: false }), // 1
  Object.freeze({ en: 'Bone', ru: 'Кости', def: false }), // 2
  Object.freeze({ en: 'Cinders', ru: 'Пепла', def: false }), // 3
  Object.freeze({ en: 'Night', ru: 'Ночи', def: false }), // 4
  Object.freeze({ en: 'Dust', ru: 'Пыли', def: false }), // 5
  Object.freeze({ en: 'Flame', ru: 'Пламени', def: false }), // 6
  Object.freeze({ en: 'Heat', ru: 'Жара', def: false }), // 7
  Object.freeze({ en: 'Sorrow', ru: 'Печали', def: false }), // 8
  Object.freeze({ en: 'Silence', ru: 'Молчания', def: false }), // 9
  Object.freeze({ en: 'the Instructor', ru: 'Наставника', def: true }), // 10
  Object.freeze({ en: 'the Choir', ru: 'Хора', def: true }), // 11
  Object.freeze({ en: 'the Pupil', ru: 'Ученика', def: true }), // 12
  Object.freeze({ en: 'the Master', ru: 'Учителя', def: true }), // 13
  Object.freeze({ en: 'the Word', ru: 'Слова', def: true }), // 14
  Object.freeze({ en: 'the Vault', ru: 'Склепа', def: true }), // 15
  Object.freeze({ en: 'the Crypt', ru: 'Усыпальницы', def: true }), // 16
  Object.freeze({ en: 'the Well', ru: 'Колодца', def: true }), // 17
  Object.freeze({ en: 'the Pyre', ru: 'Костра', def: true }), // 18
  Object.freeze({ en: 'the Forge', ru: 'Горна', def: true }), // 19
  Object.freeze({ en: 'the Quarry', ru: 'Каменоломни', def: true }), // 20
  Object.freeze({ en: 'the Waste', ru: 'Пустоши', def: true }), // 21
  Object.freeze({ en: 'the Gate', ru: 'Врат', def: true }), // 22
  Object.freeze({ en: 'the Threshold', ru: 'Порога', def: true }), // 23
  Object.freeze({ en: 'Winter', ru: 'Зимы', def: false }), // 24
  Object.freeze({ en: 'Autumn', ru: 'Осени', def: false }), // 25
  Object.freeze({ en: 'Hunger', ru: 'Голода', def: false }), // 26
  Object.freeze({ en: 'Thirst', ru: 'Жажды', def: false }), // 27
  Object.freeze({ en: 'Wrath', ru: 'Гнева', def: false }), // 28
  Object.freeze({ en: 'Spite', ru: 'Злобы', def: false }), // 29
  Object.freeze({ en: 'Mercy', ru: 'Милости', def: false }), // 30
  Object.freeze({ en: 'Ruin', ru: 'Разрухи', def: false }), // 31
  Object.freeze({ en: 'the Ending', ru: 'Исхода', def: true }), // 32
  Object.freeze({ en: 'the Last Hour', ru: 'Последнего часа', def: true }), // 33
  Object.freeze({ en: 'the First Lesson', ru: 'Первого урока', def: true }), // 34
  Object.freeze({ en: 'the Hollow', ru: 'Пустоты', def: true }), // 35
  Object.freeze({ en: 'the Deep', ru: 'Глубины', def: true }), // 36
  Object.freeze({ en: 'the Fall', ru: 'Падения', def: true }), // 37
  Object.freeze({ en: 'the Long Road', ru: 'Долгой дороги', def: true }), // 38
  Object.freeze({ en: 'Iron', ru: 'Железа', def: false }), // 39
  Object.freeze({ en: 'Salt', ru: 'Соли', def: false }), // 40
  Object.freeze({ en: 'Glass', ru: 'Стекла', def: false }), // 41
  Object.freeze({ en: 'Cold', ru: 'Стужи', def: false }), // 42
  Object.freeze({ en: 'Smoke', ru: 'Дыма', def: false }), // 43
  Object.freeze({ en: 'Rot', ru: 'Гнили', def: false }), // 44
  Object.freeze({ en: 'Bile', ru: 'Желчи', def: false }), // 45
  Object.freeze({ en: 'the Faithless', ru: 'Отступника', def: true }), // 46
  Object.freeze({ en: 'the Nameless', ru: 'Безымянного', def: true }), // 47
  Object.freeze({ en: 'the Unlearned', ru: 'Неучёного', def: true }), // 48
]);
