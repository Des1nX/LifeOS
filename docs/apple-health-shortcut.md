# LifeOS Health Sync — zkratka pro Apple Health (zdarma, bez Macu)

Tento návod vytvoří v aplikaci **Zkratky (Shortcuts)** na iPhonu zkratku **`LifeOS Health Sync`**.
Zkratka přečte data z aplikace **Zdraví (Apple Health)**, složí je do JSON a zkopíruje do schránky.
LifeOS (webová / Home Screen aplikace) je pak po klepnutí na **Načíst data** přečte ze schránky a uloží
**jen lokálně v tomto zařízení**. Nic se neposílá na server.

```
Apple Health → zkratka „LifeOS Health Sync“ → JSON ve schránce → LifeOS → IndexedDB v zařízení
```

Nepotřebuješ Mac, Xcode, placený Apple Developer účet ani žádnou další aplikaci — Zkratky jsou součástí iOS.

> **Stav ověření:** webová strana LifeOS (import, validace, zobrazení) je automaticky otestovaná.
> Samotnou zkratku je nutné ověřit na skutečném iPhonu (viz „Test na iPhonu“ na konci).
> Názvy akcí níže jsou anglické (jak je ukazuje iOS v angličtině). V češtině mají akce přeložené názvy —
> v hledání akcí stačí napsat **„Health“ / „Zdraví“**, **„Dictionary“ / „Slovník“**, **„Clipboard“ / „Schránka“** apod.

---

## 0. Co budeš potřebovat

* iPhone se současným iOS a aplikacemi **Zdraví** a **Zkratky** (předinstalované).
* LifeOS otevřený přes HTTPS (ideálně přidaný na plochu: Safari → Sdílet → Přidat na plochu).
* Pro spánkové fáze (jádrový / hluboký / REM) Apple Watch se sledováním spánku. Bez hodinek může Zdraví mít
  jen „Spím“ (bez fází) — LifeOS to zvládne.

## 1. Založ zkratku

1. Otevři **Zkratky** → **+** (nová zkratka).
2. Nahoře klepni na název a přejmenuj ji přesně na **`LifeOS Health Sync`**
   (LifeOS ji spouští tímto názvem: `shortcuts://run-shortcut?name=LifeOS%20Health%20Sync`).

## 2. Datum a rozsah (posledních 30 dní)

| # | Akce | Nastavení | Proměnná / výstup |
|---|------|-----------|-------------------|
| 1 | **Date** (Datum) | **Current Date** (Aktuální datum) | výstup přejmenuj (klepni na něj → Rename) na **Now** |
| 2 | **Format Date** | Date: **Now** · Date Format: **Custom** · Format String: `yyyy-MM-dd` | přejmenuj na **ToDate** |
| 3 | **Adjust Date** | **Subtract** `29` **days** from **Now** | přejmenuj na **FromRaw** |
| 4 | **Format Date** | Date: **FromRaw** · Custom · `yyyy-MM-dd` | přejmenuj na **FromDate** |
| 5 | **Format Date** | Date: **Now** · Date Format: **ISO 8601** · **Include ISO 8601 Time: zapnuto** | přejmenuj na **Generated** |

> Chceš jen 7 dní? V kroku 3 dej `6`, ve filtrech níže „in the last **7** days“ (u spánku 8). Jen dnešek: `0` a „Today“.

## 3. Denní metriky (jedna hodnota za den)

Pro **každou** z těchto metrik přidej stejný blok akcí. Důležité je **Group By: Day** — Zdraví pak vrátí
**denní součet / hodnotu tak, jak ji počítá samo** (LifeOS hodnoty nikdy nesčítá, takže nevzniká dvojí počítání
iPhone + Apple Watch).

| Metrika v aplikaci Zdraví (Type) | Název proměnné | Klíč v JSON |
|---|---|---|
| **Steps** (Kroky) | `StepsList` | `steps` |
| **Active Energy** (Aktivní energie) | `EnergyList` | `activeEnergy` |
| **Exercise Minutes** (Minuty cvičení) | `ExerciseList` | `exerciseTime` |
| **Walking + Running Distance** (Chůze a běh – vzdálenost) | `DistanceList` | `walkingRunningDistance` |
| **Flights Climbed** (Vystoupaná patra) | `FlightsList` | `flightsClimbed` |
| **Resting Heart Rate** (Klidová tepová frekvence) | `RestingHRList` | `restingHeartRate` |
| **Heart Rate Variability** (Variabilita srdečního tepu) | `HRVList` | `heartRateVariability` |
| **VO2 Max** (v aplikaci Zdraví „Kardiokondice“ / Cardio Fitness) | `VO2List` | `vo2Max` |

Blok akcí (příklad pro **Steps**):

| # | Akce | Nastavení | Výstup |
|---|------|-----------|--------|
| a | **Find Health Samples** | **Type is Steps** · přidej filtr **Start Date is in the last 30 days** · **Sort by: Start Date** · **Order: Oldest First** · **Group By: Day** · **Fill Missing: vypnuto** · Limit: vypnuto | seznam denních hodnot |
| b | **Repeat with Each** | vstup: výsledek akce **a** | uvnitř opakování: |
| c | ↳ **Get Details of Health Sample** | **Start Date** z **Repeat Item** | |
| d | ↳ **Format Date** | Date: výsledek **c** · Custom · `yyyy-MM-dd` | datum dne |
| e | ↳ **Get Details of Health Sample** | **Value** z **Repeat Item** | hodnota |
| f | ↳ **Get Details of Health Sample** | **Unit** z **Repeat Item** | jednotka |
| g | ↳ **Dictionary** | klíč `date` (Text) = výsledek **d** · klíč `value` (Number) = výsledek **e** · klíč `unit` (Text) = výsledek **f** | jeden den |
| h | ↳ **Add to Variable** | přidej **Dictionary** do proměnné **StepsList** | |
| i | **End Repeat** | | |

Pro ostatní metriky blok zopakuj s jiným **Type** a jinou proměnnou (viz tabulka).
Když v aplikaci Zdraví žádná data daného typu nemáš (např. HRV bez hodinek), nevadí — LifeOS metriku jen nezobrazí.

Jednotky: LifeOS převede `mi → km`, `lb → kg`, `kJ → kcal`. `Cal` (velké C, jak ji iOS skutečně posílá u aktivní energie)
je kilokalorie, tedy totéž co `kcal` — hodnota se **nenásobí** 1000. Neznámou jednotku odmítne (hodnotu přeskočí).

## 4. Hmotnost (každé měření)

| # | Akce | Nastavení | Výstup |
|---|------|-----------|--------|
| a | **Find Health Samples** | **Type is Weight** (Hmotnost) · **Start Date is in the last 30 days** · Sort by Start Date · Oldest First · **Group By: None** | měření |
| b | **Repeat with Each** | | |
| c | ↳ **Get Details of Health Sample** → **Start Date**, pak **Format Date** → **ISO 8601** + čas | | čas měření |
| d | ↳ **Get Details of Health Sample** → **Value**, a zvlášť → **Unit** | | |
| e | ↳ **Dictionary**: `date` = čas z **c**, `value` = Value, `unit` = Unit → **Add to Variable** `WeightList` | | |

LifeOS si pro každý den vezme **poslední měření dne** (nesčítá).

## 5. Spánek (jednotlivé fáze)

| # | Akce | Nastavení | Výstup |
|---|------|-----------|--------|
| a | **Find Health Samples** | **Type is Sleep Analysis** (Spánek) · **Start Date is in the last 31 days** (o den víc kvůli první noci) · Sort by Start Date · Oldest First · **Group By: None** | všechny spánkové vzorky |
| b | **Repeat with Each** | | |
| c | ↳ **Get Details of Health Sample** → **Start Date** → **Format Date**: **ISO 8601** + **Include Time** | | `start` |
| d | ↳ **Get Details of Health Sample** → **End Date** → **Format Date**: **ISO 8601** + **Include Time** | | `end` |
| e | ↳ **Get Details of Health Sample** → **Value** | | např. „Core“, „Deep“, „REM“, „Awake“, „In Bed“ |
| f | ↳ **Dictionary**: `start`, `end`, `value` → **Add to Variable** `SleepList` | | |

Jak LifeOS spánek počítá:
* Noc patří ke dni, kdy ses **probudil/a** (spánek 23:45 → 07:42 = den 07:42). Den běží jako ve Zdraví od 18:00 do 18:00.
* **Celkový spánek = jádrový + hluboký + REM + „Spím“ (Asleep)** — z „Spím“ se odečtou úseky „Vzhůru“.
  Normalizované úseky noci se ukládají pro časovou osu „Dnešní spánek“ (viz kapitola 11).
  **Vzhůru a V posteli se nepočítají.** iPhone často posílá jeden dlouhý úsek „Asleep“ přes celou noc současně
  s fázemi z hodinek; díky sjednocení se nic nezapočítá dvakrát.
* Překrývající se vzorky (např. z iPhonu i hodinek) se nikdy nesčítají dvakrát — LifeOS bere jejich sjednocení.
* LifeOS zná anglické i české názvy fází i číselné hodnoty HealthKitu. Neznámou hodnotu přeskočí a ukáže to v náhledu.
* Apple Health nedává „kvalitu spánku v %“ — LifeOS žádnou nevymýšlí. Tvoje ručně zadaná kvalita zůstává.

## 6. Složení JSON a kopírování do schránky

| # | Akce | Nastavení | Výstup |
|---|------|-----------|--------|
| 1 | **Dictionary** | klíče `from` (Text) = **FromDate**, `to` (Text) = **ToDate** | přejmenuj na **Range** |
| 2 | **Dictionary** | prázdný | přejmenuj na **Metrics** |
| 3 | **Set Dictionary Value** | Set `steps` to **StepsList** in **Metrics** | (výstup ulož znovu jako **Metrics** přes **Set Variable**) |
| 4 | totéž pro `activeEnergy` = EnergyList, `exerciseTime` = ExerciseList, `walkingRunningDistance` = DistanceList, `flightsClimbed` = FlightsList, `restingHeartRate` = RestingHRList, `heartRateVariability` = HRVList, `vo2Max` = VO2List, `weight` = WeightList | | **Metrics** |
| 5 | **Dictionary** | `protocol` (Text) = `lifeos-apple-health` · `version` (Number) = `1` · `generatedAt` (Text) = **Generated** · `deviceTimezone` (Text) = `Europe/Prague` (tvoje časové pásmo) | přejmenuj na **Payload** |
| 6 | **Set Dictionary Value** | `range` = **Range** v **Payload** → **Set Variable** Payload | |
| 7 | **Set Dictionary Value** | `metrics` = **Metrics** v **Payload** → **Set Variable** Payload | |
| 8 | **Set Dictionary Value** | `sleep` = **SleepList** v **Payload** → **Set Variable** Payload | |
| 9 | **Text** | vlož proměnnou **Payload** (Slovník se v textu převede na JSON) | JSON text |
| 10 | **Copy to Clipboard** | vstup: výsledek **Text** | |
| 11 | **Show Notification** (volitelné) | „Data jsou ve schránce — vrať se do LifeOS a klepni na Načíst data.“ | |

Proč **Set Dictionary Value**: vloží seznam (proměnnou) jako skutečné JSON pole, ne jako text.

Výsledný JSON vypadá takto (zkráceno):

```json
{
  "protocol": "lifeos-apple-health",
  "version": 1,
  "generatedAt": "2026-10-03T08:30:00+02:00",
  "deviceTimezone": "Europe/Prague",
  "range": { "from": "2026-09-04", "to": "2026-10-03" },
  "metrics": {
    "steps": [{ "date": "2026-10-03", "value": 8312, "unit": "count" }],
    "activeEnergy": [{ "date": "2026-10-03", "value": 468, "unit": "kcal" }],
    "restingHeartRate": [{ "date": "2026-10-03", "value": 54, "unit": "count/min" }],
    "weight": [{ "date": "2026-10-03T07:05:00+02:00", "value": 81.6, "unit": "kg" }]
  },
  "sleep": [
    { "start": "2026-10-02T23:45:00+02:00", "end": "2026-10-03T01:10:00+02:00", "value": "Core" },
    { "start": "2026-10-03T01:10:00+02:00", "end": "2026-10-03T02:05:00+02:00", "value": "Deep" }
  ]
}
```

## 6a. Jak zkratka data skutečně posílá (pozorováno na skutečném iPhonu)

Na skutečném iPhonu Zkratky **neserializují** slovníky a seznamy tak, jak by člověk čekal z kroku 6.
Pozorovaný výstup vypadá takto (syntetický příklad, ne skutečná data):

```json
{
  "protocol": "lifeos-apple-health",
  "version": 1,
  "generatedAt": "2026-10-03T08:30:00+02:00",
  "deviceTimezone": "Europe/Prague",
  "range": "{\"to\":\"2026-10-03\",\"from\":\"2026-09-04\"}",
  "metrics": "{\"steps\":\"{\\\"value\\\":\\\"12045\\\",\\\"date\\\":\\\"2026-09-03\\\",\\\"unit\\\":\\\"count\\\"}\\n{...}\",\"activeEnergy\":\"...\",\"exerciseTime\":[],...}",
  "sleep": "{\"value\":\"Core\",\"start\":\"...\",\"end\":\"...\"}\n{\"value\":\"Deep\",...}"
}
```

Tedy:

* `range` a `metrics` jsou **JSON v textovém řetězci** (Slovník vložený do Slovníku se převede na text).
* Seznamy `steps`, `activeEnergy` a `sleep` jsou **NDJSON** — text, kde každý řádek je jeden JSON objekt.
  Metriky bez dat jsou prázdné pole `[]`.
* Čísla jsou **text** (`"12045"`, `"667.2000000000002"`), jednotka aktivní energie je `"Cal"` (= kcal).
* Kroky a energie obsahují i **den před** `range.from`; spánek kvůli 31dennímu dotazu začíná ještě o noc dřív.
* Hodnoty spánku: `Asleep`, `Awake`, `Core`, `Deep`, `In Bed`, `REM`; `Asleep` se překrývá s fázemi.

**LifeOS přijímá oba formáty** — tento skutečný i „čistý“ JSON z ukázky v kroku 6. Zkratku tedy
**není potřeba předělávat** ani bojovat s tím, jak Zkratky převádějí data na text. Před validací LifeOS:

1. rozbalí jen známá pole: `range`, `metrics`, jednotlivé seznamy metrik a `sleep`
   (ostatní texty — `protocol`, `generatedAt`, `deviceTimezone`, `unit`, `date`, hodnota spánku — zůstávají textem);
2. NDJSON rozdělí po řádcích, prázdné řádky přeskočí; **každý** řádek musí být JSON objekt —
   jediný vadný řádek (neplatný JSON, pole, číslo, zakázaný klíč `__proto__` / `constructor` / `prototype`)
   odmítne **celý** import, nic se částečně neuloží;
3. čísla bere jen v přísném tvaru (`123`, `123.45`, i jako text); `""`, `abc`, `12abc`, `NaN`, `Infinity` odmítne;
4. dál platí všechny kontroly: max. 5 MB, protokol, verze, data, rozsah, rozumné meze hodnot.

Přesah dat: denní metriky se berou až **1 den před** `range.from`, spánek až **2 dny před**
(neúplná noc dva dny zpět se tiše vynechá, aby se nezobrazil useknutý spánek). Starší vzorky a cokoli po
`range.to` se přeskočí a náhled to uvede jako varování.

## 7. Povolení

Při prvním spuštění se Zkratky zeptají na přístup ke Zdraví — povol čtení všech typů výše.
Zkratka nic do Zdraví nezapisuje.

## 8. Synchronizace v LifeOS

1. LifeOS → **Nastavení → Apple Health → Synchronizovat Apple Health** (spustí zkratku).
2. Počkej na dokončení zkratky (případně notifikaci).
3. **Vrať se do LifeOS ručně** (iOS neumí po zkratce automaticky otevřít aplikaci z plochy).
4. Klepni na **Načíst data** (banner dole) nebo **Nastavení → Apple Health → Načíst data ze schránky**.
   iOS zobrazí bublinu **Vložit** — potvrď ji.
5. Zkontroluj **náhled** (počty dní / nocí / měření) → **Importovat**.

Když čtení schránky selže: **Vložit data ručně** → dlouze podrž v poli → **Vložit** → **Zkontrolovat**.

## 9. Test na iPhonu (proti aplikaci Zdraví)

1. Spusť zkratku samotnou ve Zkratkách → povol přístup ke Zdraví.
2. Otevři Poznámky → Vložit: zkontroluj, že ve schránce je JSON začínající `{"protocol":"lifeos-apple-health"`.
3. V LifeOS: Synchronizovat → po návratu Načíst data → náhled → Importovat.
4. Porovnej s aplikací Zdraví pro dnešek a 2–3 starší dny:
   * **Spánek** (Zdraví → Spánek → den): celkem „Spánek“ a fáze jádrový / hluboký / REM / vzhůru.
   * **Aktivní energie**, **Minuty cvičení**, **Vzdálenost**, **Patra** (Zdraví → Aktivita, denní hodnoty).
   * **Kroky** — hlavně den, kdy jsi měl/a iPhone i hodinky (ověření, že se nesčítají dvakrát).
   * **Klidový tep**, **HRV**, **VO2 max**, **Hmotnost** (poslední měření dne).
5. Spusť sync podruhé hned po prvním → LifeOS má hlásit „Žádné nové údaje“.
6. Vlož do LifeOS starší JSON (z bodu 2 před novým syncem) → má hlásit, že je starší a ignoruje se.
7. Zapni režim Letadlo → Načíst data / Importovat musí fungovat i offline.
8. Nastavení → Apple Health → Preferovat Apple Health: vypni / zapni a sleduj, že ručně zadaný spánek se nezměnil.

---

## 10. Kde se Apple Health data v LifeOS zobrazují

Apple Health už není samostatný panel s kopií všech čísel. Importovaná data se zobrazují tam, kam patří,
přes jednu vrstvu „efektivních“ hodnot (`getEffective…`):

| Metrika | Kde | Ruční záloha (když Apple hodnota chybí) |
|---|---|---|
| Spánek | Zdraví → Přehled, záložka Spánek (časová osa, souhrn, 30denní graf) | ruční zápis spánku |
| Kroky (beta) | Zdraví → Přehled | staré ruční záznamy kroků |
| Aktivní energie | Zdraví → Přehled, záložka Aktivní kcal (dnešek, průměr, graf, historie) | ruční aktivní kalorie |
| Pohyb, Vzdálenost, Patra | Zdraví → Přehled | — |
| Hmotnost | Zdraví → Přehled, záložka Váha (poslední, trend, graf, historie) | ruční vážení |
| Klidový tep | Zdraví → Přehled | ruční záznam tepu typu „klidový“ |
| HRV (SDNN), VO2 max | Zdraví → Přehled | — |

Pravidla:
* **Preferovat Apple Health zapnuto a Apple hodnota existuje → Apple Health.**
  Jinak ruční hodnota (pokud ji LifeOS má), jinak prázdný stav — **nikdy falešná nula**.
* U každé hodnoty je nenápadný štítek zdroje: **Apple Health** nebo **Manuálně**.
* Ruční záznamy se nikdy nepřepisují ani nekopírují — zůstávají vlastní historií s úpravou a mazáním.
  Řádky z Apple Health v historii jsou jen pro čtení.
* Horní panel **Apple Health** na obrazovce Zdraví ukazuje jen stav: propojení přes zkratku, poslední synchronizaci,
  přepínač preference, tlačítko Synchronizovat a **Diagnostiku dat** (rozsah, časové pásmo, počty dní a metrik,
  zdroje kroků, počet tréninků).
* Když je Apple Health nepropojené nebo vypnuté, obrazovka Zdraví vypadá i počítá přesně jako dřív.

## 11. Spánek — časová osa fází („Dnešní spánek“)

Nad 30denním grafem délky spánku je karta **Dnešní spánek**: skutečná časová osa noci od usnutí do posledního
probuzení se čtyřmi pruhy:

| Pruh | Hodnota ze Zdraví |
|---|---|
| Vzhůru | Awake |
| REM | REM |
| Lehký | Core |
| Hluboký | Deep |

* LifeOS si při importu ukládá normalizované úseky noci (`sleep.segments` u každého dne, volitelné a zpětně kompatibilní).
  Kde se vzorky překrývají, vyhraje ten konkrétnější (Hluboký > REM > Lehký > Vzhůru > „Spím“), takže hrubý úsek
  „Asleep“ z iPhonu nikdy nevytvoří druhý pruh a jen vyplní čas, který žádná fáze nepokrývá. **V posteli** pruh nemá.
* Součet úseků odpovídá přesně celkovému spánku (stejná pravidla jako dosud: Lehký + Hluboký + REM + „Spím“ mimo
  úseky Vzhůru; nic se nepočítá dvakrát).
* Noc, kde Zdraví má jen „Spím“ bez fází, ukáže neutrální pruh **Spánek** — LifeOS fáze nevymýšlí.
* Pod osou je souhrn: Celkem, Lehký, Hluboký, REM, Vzhůru. Ručně zadaná kvalita spánku se ukáže s poznámkou
  „zadaná ručně“; Apple Health kvalitu v % nemá a LifeOS žádnou nevymýšlí.
* Pro čtečky obrazovky a kontrolu je tu „Zobrazit fáze jako seznam“.
* Data importovaná starší verzí LifeOS (bez úseků) časovou osu ukážou po další synchronizaci.

## 12. Kroky — Beta a rozdíl proti aplikaci Zdraví

Na skutečném iPhonu zkratka vrátila pro dnešek **460** kroků, zatímco aplikace Zdraví ukazovala **348**.
Zdraví při více zdrojích (iPhone + Apple Watch) slučuje a upřednostňuje data podle vlastních, nezveřejněných pravidel;
výsledek akce **Find Health Samples** s **Group By: Day** se od toho může lišit.

LifeOS proto:
* nechává kroky označené **Beta** a u dlaždice ukazuje: „Hodnota ze Zkratek se může lišit od souhrnu v aplikaci
  Zdraví při více zdrojích dat.“;
* **nepoužívá žádný korekční koeficient** a netvrdí, že hodnoty sedí;
* nikdy nesčítá kroky z více zdrojů (to by počítalo kroky dvakrát).

**Volitelné pole `source`.** Záznam kroků může mít navíc zdroj:

```json
{ "date": "2026-10-03", "value": "348", "unit": "count", "source": "iPhone" }
```

* Záznam **bez** `source` (dosavadní seznam ze zkratky) = denní souhrn. Nic se nemění — stávající zkratka funguje dál.
* Záznamy **se** `source` se uloží zvlášť pro diagnostiku (**Zdroj kroků** na dlaždici Kroky).
  Když v daném dni přijde jen jeden zdroj a žádný souhrn, je to celkový počet dne.
* Když zkratka posílá aspoň dva zdroje, v **Zdroj kroků** lze vybrat: Automaticky (souhrn zkratky) — výchozí —
  nebo konkrétní zdroj. Bez těchto dat LifeOS výběr nenabízí (nic se nepředstírá).

Jak zdroje poslat (volitelné): pokud akce **Find Health Samples** na tvém iOS nabízí filtr podle zdroje, přidej pro
kroky další blok z kroku 3 s tímto filtrem (např. iPhone, Apple Watch) a do slovníku každého dne přidej klíč `source`
(Text) s názvem zdroje. Původní blok bez filtru ponech — dává souhrn. Když filtr podle zdroje není k dispozici,
nic nepřidávej: kroky dál fungují jako souhrn (Beta) a výběr zdroje se v LifeOS nezobrazí.

## 13. Tréninky z Apple Watch (volitelné)

**Omezení nativních Zkratek:** spolehlivé čtení dokončených tréninků (typ, délka, kalorie tréninku, zdroj) vestavěné
akce Zkratek nezaručují. LifeOS proto **nevyrábí tréninky z denních aktivních kalorií** — denní součet není
spálená energie jednoho tréninku.

**Řešení: bezplatná aplikace Actions (Sindre Sorhus)** z App Store. Přidá do Zkratek akci **Find Workout** (jen iOS),
která vrací tréninky ze Zdraví včetně typu, délky, zdroje a aktivních kalorií. Zbytek synchronizace funguje i bez ní.

Do zkratky přidej (za spánek, před složení JSON):

| # | Akce | Nastavení |
|---|------|-----------|
| a | **Find Workout** (Actions) | tréninky za posledních 30 dní (nastavení filtru podle nabídky akce) |
| b | **Repeat with Each** | vstup: výsledek **a** |
| c | ↳ vlastnosti tréninku | klepni na **Repeat Item** a vyber vlastnost — začátek, konec, typ, délka, aktivní energie, vzdálenost, zdroj, UUID (přesné názvy vlastností ukazuje aplikace Actions) |
| d | ↳ **Format Date** | začátek a konec: **ISO 8601** + **Include Time** |
| e | ↳ **Dictionary** | klíče níže → **Add to Variable** `WorkoutList` |
| f | **End Repeat** | |
| g | **Set Dictionary Value** | `workouts` = **WorkoutList** v **Payload** (stejně jako `sleep`) |

Klíče slovníku jednoho tréninku:

| Klíč | Povinný | Hodnota |
|---|---|---|
| `start` | ano | ISO 8601 s časem a posunem, např. `2026-10-03T18:04:00+02:00` |
| `end` | ano | ISO 8601 |
| `type` | doporučeno | typ tréninku (např. `Traditional Strength Training`, `Running`) |
| `id` | doporučeno | UUID tréninku, pokud ho akce nabízí (písmena, čísla, `-`, `_`, `.`, `:`) |
| `durationSec` | ne | délka v sekundách (jinak `end − start`); alternativně `durationMin` |
| `activeKcal` | ne | aktivní energie **tohoto tréninku**; `energyUnit` volitelně `kcal` / `Cal` / `kJ` |
| `totalKcal` | ne | celková energie, pokud ji akce dává |
| `distanceKm` | ne | vzdálenost; `distanceUnit` volitelně `km` / `mi` / `m` |
| `source` | ne | zdroj, např. `Apple Watch` |
| `name` | ne | vlastní název |

Čísla mohou být i text (`"412"`). Seznam smí přijít jako pole i jako NDJSON text (stejně jako kroky a spánek).
Identita tréninku: `id`, jinak deterministický klíč ze zdroje + typu + začátku + konce — opakovaná synchronizace
nikdy nevytvoří druhou kopii. Chybný trénink (nečitelný čas, konec před začátkem, délka delší než `end − start`,
nečíselné kalorie, příliš dlouhý text…) se přeskočí a náhled to ukáže jako varování.

**V LifeOS:** Fitness → **Přidat trénink z Apple Health** → seznam posledních tréninků (typ, den a začátek, délka,
kcal, vzdálenost, zdroj; už přidané mají „Už přidáno“) → náhled → **Zrušit** / **Přidat do LifeOS**.
* Trénink se **nikdy nepřidá sám** — vždy až po potvrzení.
* V historii Fitness se ukáže s **Spáleno: … kcal** (kalorie tréninku, ne denní součet) a štítkem Apple Health.
* **0 XP, 0 atributů, 0 questů, 0 achievementů, žádná změna Daily Score ani připravenosti.** Import je záznam,
  ne splnění v LifeOS (odměny za trénink v Gym Mode se nemění).
* Smazání kopie v LifeOS v Apple Health nic nemaže. Trénink se pak v seznamu ukáže jako „Odebráno z LifeOS — lze
  přidat znovu“.

## 14. Soukromí

* Vše se zpracovává lokálně v LifeOS na tomto zařízení (IndexedDB). Žádný server, žádné odesílání.
* Data přicházejí jen přes schránku (nebo ruční vložení) a schránka se čte jen po klepnutí.
* LifeOS do Apple Health nikdy nic nezapisuje.
