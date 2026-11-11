# AUX Home szobahőmérséklet

A két csomag az upstream `beta` `8f44427c72badb061c441def5a56ff9f61478edf` commitjára épül. A diagnosztikai csomag ugyanazt a javítást tartalmazza, plusz szűrt REST- és MQTT-naplózást. A csomag neve és a Homebridge-regisztráció az eredeti pluginé.

A hibát a `CurrentTemperature` 24 °C-os alapértéke okozta, amikor az `envtemp` hiányzott. Az ismert AUXLink-állapotkeret célhőmérsékletet ad (`temp`), a REST-provider pedig a `status` numerikus mezőit veszi át. Az AC Freedom külön adatútja az `envtemp` értékét tized Celsius-fokban adja át. Az AUX Home élő REST-mezőinek neve és skálázása még ellenőrzésre vár.

## 1. Másolás

Ha GitHubról indulsz, a naplózás nélküli csomagot így készítheted el **FEJLESZTŐGÉPEN**, egy új könyvtárban. A verziócímke csak az ideiglenes csomagolási könyvtárban változik.

```sh
(
  set -eu
  git clone --single-branch --branch fix/aux-home-ambient-temperature \
    https://github.com/themokx1/homebridge-aux-cloud.git
  cd homebridge-aux-cloud
  npm install
  npm run build
  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT
  cp -R dist package.json config.schema.json README.md LICENSE "$staging/"
  (cd "$staging" && npm pkg set version=0.0.14-beta.1.ambient-fix)
  npm pack "$staging" --ignore-scripts
)
```

**FEJLESZTŐGÉPEN** a fork gyökerében. AirDroppal másold a két `.tgz` fájlt a Mac mini `Downloads` mappájába. Ha be van kapcsolva a Remote Login, az alábbi parancs is használható a Mac mini tényleges gépnevével.

```sh
scp homebridge-aux-cloud-0.0.14-beta.1.ambient-{fix,diagnostics}.tgz macmini@MAC_MINI_HOST:Downloads/
```

## 2. Az eredeti telepítés mentése és a diagnosztikai csomag telepítése

**MAC MININ**, a meglévő Homebridge-felhasználó termináljában. Először tölts le egy Homebridge-mentést a UI **Backup / Restore** menüjéből. A plugin könyvtárát is külön mentjük, így a két helyileg módosított `dist` fájl és a `.bak` fájlok visszaállíthatók.

A parancsok a meglévő `hb-service` telepítést használják. Ha a szolgáltatást más módszerrel indítod, a saját stop/start parancsaiddal végezd a leállítást és az indítást. A mentési könyvtár létrehozása meglévő azonos nevű mentés esetén megáll.

SSH-n vagy a Mac mini saját Terminal alkalmazásában illeszd be a teljes blokkot. A Homebridge webes terminál kapcsolata megszakadhat a szolgáltatás leállításakor. Ha a GitHub-ágból készített csomagot használod, a `variant=ambient-diagnostics` sort cseréld `variant=ambient-fix` értékre.

```sh
(
  set -eu
  export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
  test "$(node -v)" = v22.18.0
  test "$(npm root -g)" = "$HOME/.nvm/versions/node/v22.18.0/lib/node_modules"
  command -v hb-service
  plugin="$(npm root -g)/homebridge-aux-cloud"
  backup="$HOME/homebridge-aux-ambient-rollback"
  variant=ambient-diagnostics
  tgz="$HOME/Downloads/homebridge-aux-cloud-0.0.14-beta.1.$variant.tgz"
  if [ ! -f "$tgz" ]; then
    printf 'Package not found: %s\n' "$tgz" >&2
    exit 1
  fi
  test "$(node -p 'require(process.argv[1]).version' "$plugin/package.json")" = 0.0.14-beta.1
  mkdir -m 700 "$backup"
  ditto "$plugin" "$backup/homebridge-aux-cloud"
  hb-service stop
  npm install -g --omit=peer --ignore-scripts "$tgz"
  test "$(node -p 'require(process.argv[1]).version' "$plugin/package.json")" = "0.0.14-beta.1.$variant"
  hb-service start
)
```

A child bridge beállításai, a Homebridge `persist` és `accessories` könyvtára, valamint a platformkonfiguráció a helyén marad. A javítás ugyanazokat a szolgáltatásokat és UUID-ket használja. Ha a telepítés az újraindítás előtt hibával megáll, használd a visszaállítást.

## 3. Élő próba és szűrt kimenet

**MAC MININ** futtasd a következőt, vagy a Homebridge UI naplójában keress az `[AUX ambient probe]` szövegre.

```sh
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
hb-service logs | grep -F '[AUX ambient probe]'
```

1. A betöltés után várj legalább egy 60 másodperces pollt. Egy működő klímán változtasd meg a célhőmérsékletet a fizikai távirányítóval, majd figyeld az MQTT-sort. A klíma saját állapotát is ellenőrizd.
2. Az Apple Home-ból próbáld ki egy klíma bekapcsolását és a célhőmérséklet beállítását. Jegyezd fel az aktuális hőmérséklet kijelzését és azt, hogy reagált-e a készülék.
3. Küldj vissza legfeljebb 2–3 különböző `REST` és 2–3 különböző `MQTT` próbasort, az Apple Home eredményével együtt. Ha csak az egyik forrásból érkezik sor, ezt írd meg. A REST szűrt mezőneveket, típusokat és nyers numerikus hőmérsékletértékeket közöl. Az MQTT az üzenet hosszát és az ismert állapotkeretből dekódolt célhőmérsékletet közli.

A próba a Homebridge szokásos AUX Home-munkamenetéből gyűjt. Ha bejelentkezési zárolás jelenik meg, várd meg a lejártát, mielőtt újraindítod a szolgáltatást.

## 4. Váltás a diagnosztika nélküli javításra

**MAC MININ**, ha az Apple Home-os próba után a javítást szeretnéd megtartani. Ha a klíma vezérlése romlik, állítsd vissza az eredeti telepítést az 5. lépés szerint.

```sh
(
  set -eu
  export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
  test "$(node -v)" = v22.18.0
  tgz="$HOME/Downloads/homebridge-aux-cloud-0.0.14-beta.1.ambient-fix.tgz"
  test -f "$tgz"
  hb-service stop
  npm install -g --omit=peer --ignore-scripts "$tgz"
  test "$(node -p 'require(process.argv[1]).version' "$(npm root -g)/homebridge-aux-cloud/package.json")" = 0.0.14-beta.1.ambient-fix
  hb-service start
)
```

## 5. Visszaállítás

**MAC MININ**. A mentésből az eredeti pluginfájlok kerülnek vissza. Ha a szolgáltatás már áll, a stop parancs kihagyható.

```sh
(
  set -eu
  export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
  test "$(node -v)" = v22.18.0
  plugin="$(npm root -g)/homebridge-aux-cloud"
  backup="$HOME/homebridge-aux-ambient-rollback"
  original="$backup/homebridge-aux-cloud"
  test "$(node -p 'require(process.argv[1]).version' "$original/package.json")" = 0.0.14-beta.1
  displaced="$(mktemp -d "$backup/displaced.XXXXXX")"
  hb-service stop
  if [ -d "$plugin" ]; then mv "$plugin" "$displaced/homebridge-aux-cloud"; fi
  ditto "$original" "$plugin"
  hb-service start
)
```

## HAP és ellenőrzés

A hiányzó vagy érvénytelen AUX Home-értéknél a közvetlen `CurrentTemperature` olvasás HAP `SERVICE_COMMUNICATION_FAILURE` státuszt kap. A célhőmérséklet és a kapcsolás külön karakterisztikákon működik. A Homebridge 1.11.1-ben használt HAP-NodeJS 0.14.0 a teljes `/accessories` lekérésnél a saját alapértékét adhatja egy hibát jelző kötelező karakterisztikához. Az Apple Home tényleges kijelzése és vezérelhetősége az élő próba része.

Az Apple Home egy karakterisztikahiba után az egész klímát „Nem válaszol” állapotúnak mutathatja. A diagnosztika hőmérsékletre utaló REST-mezőneveket keres a rekordban, illetve a `status` és `feature` objektum közvetlen mezőiben. Üres találati lista esetén a szűrt mezők között nem volt felismerhető hőmérsékleti adat.

## Upstream PR

**Base** `fparrav/homebridge-aux-cloud:beta`

**Title** Fix fabricated AUX Home ambient temperature in HomeKit

> When AUX Home supplies a setpoint without an ambient reading, HomeKit's CurrentTemperature fell back to 24 °C. Report a HAP communication error for the unavailable characteristic and use the existing tenths-of-a-degree Celsius contract for valid ambient readings. Cache MQTT-derived parameters separately so setpoint pushes cannot mask a later REST-only reading. Preserve AC Freedom's existing behavior.
>
> Tested with 123 automated tests, lint and a TypeScript build. HAP tests exercise read and update paths, target/ambient separation and an independent power write. Live AUX Home and Apple Home verification is pending.
