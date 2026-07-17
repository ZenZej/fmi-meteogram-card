# FMI Meteogram Card

A Lovelace custom card for Home Assistant that draws a **meteogram** — a
temperature curve, rain bars, weather-symbol row and wind arrows in a single
strip — styled after the [weather-page](https://github.com/ZenZej/weather-page)
site. It reads its data from the companion
[fmi-harmonie-ha](https://github.com/ZenZej/fmi-harmonie-ha) integration and
merges the forecast with a measured outdoor-temperature history for the recent
past.

Plain JavaScript, **no build step** — the single `fmi-meteogram-card.js` is the
source, loaded as an ES module. Symbol PNGs resolve relative to it, so they work
whether HACS serves the card from `/hacsfiles/` or you drop it in `/config/www/`.

> **Status: scaffolding.** Temperature + feels-like + rain + past/forecast merge
> + light/dark theming are implemented and verified in the dev harness. The
> weather-symbol and wind-arrow rows are wired to the new sensors but need
> live-HA verification (per-hour day/night, and wind-arrow rotation sense).

## What it shows

- **Temperature** — a smooth line coloured by value (a gradient mapped to the
  °C axis), continuous across measured **past** and forecast **future**, with a
  `now` marker at the boundary.
- **Feels like** — a dashed line on the same scale (forecast only).
- **Rain** — bars on their own right-hand mm axis (forecast only).
- **Weather symbols** — day/night icons across the top (forecast only).
- **Wind** — arrows along the bottom, sized/coloured by speed bucket and rotated
  to direction (forecast only).

## Requires

- The [fmi-harmonie-ha](https://github.com/ZenZej/fmi-harmonie-ha) integration,
  providing `sensor.<name>_temperature`, `_feels_like`, `_precipitation`,
  `_wind_speed`, `_wind_direction`, and `_weather_symbol`, each with a
  `forecast` attribute (`[{datetime, value}, …]`).
- Optionally, any outdoor-temperature sensor for the measured past (its
  short-term history is fetched over the HA websocket).

## Install (HACS custom repository)

1. HACS → ⋮ → **Custom repositories** → add this repo, category **Dashboard**.
2. Install, then add the resource if HACS doesn't do it automatically:
   `/hacsfiles/fmi-meteogram-card/fmi-meteogram-card.js` (type: **module**).
3. Add the card to a dashboard (see below).

## Configuration

```yaml
type: custom:fmi-meteogram-card
title: Helsinki
prefix: sensor.fmi_harmonie          # entity prefix for the fmi_harmonie sensors
outdoor_temperature: sensor.outdoor_temp   # optional: measured past
hours_past: 12
hours_future: 24
```

| Option | Default | Description |
| --- | --- | --- |
| `prefix` | `sensor.fmi_harmonie` | Prefix used to derive the six forecast sensors. |
| `entities` | — | Map to override individual entity ids (`temperature`, `feels_like`, `precipitation`, `wind_speed`, `wind_direction`, `weather_symbol`). |
| `outdoor_temperature` | — | Sensor whose recent history draws the measured past. Omit for forecast-only. |
| `hours_past` / `hours_future` | 12 / 24 | Window around *now*. |
| `title` | `Forecast` | Card heading. |

## Development (no HA required)

The card runs standalone against a mocked `hass` (states + a `callWS` history
stub):

```bash
cd fmi-meteogram-card
python3 -m http.server 8777
# open http://localhost:8777/dev/preview.html
```

The preview loads the real `fmi-meteogram-card.js`, so it exercises the actual
`setConfig` / `hass` / render path — only the data is mocked. A theme toggle
previews light and dark.

## Credits

Design and the weather/wind/sun icons in `symbols/` are original work by the
author (shared with the `weather-page` project). Weather data via the Finnish
Meteorological Institute [open data](https://en.ilmatieteenlaitos.fi/open-data)
(through `fmi-harmonie-ha`), used under its open-data licence.

## License

[MIT](LICENSE) © ZenZej. The bundled `symbols/` icons are the author's original
design and are covered by the same MIT license.
