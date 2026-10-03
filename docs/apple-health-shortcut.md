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

Jednotky: LifeOS převede `mi → km`, `lb → kg`, `kJ → kcal`. Neznámou jednotku odmítne (hodnotu přeskočí).

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
* **Celkový spánek = jádrový + hluboký + REM** (+ „Spím“ bez fází, pokud fáze nejsou). **Vzhůru a V posteli se nepočítají.**
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
