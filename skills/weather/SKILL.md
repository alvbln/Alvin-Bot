---
name: Weather
description: Get weather forecasts and conditions
triggers: weather, wetter, forecast, vorhersage, temperature, temperatur, rain, regen, wind
priority: 4
category: utility
---

# Weather

## Quick Weather
```bash
curl -s "wttr.in/Berlin?format=%l:+%c+%t+%w+%h"
```

## Detailed Forecast
```bash
curl -s "wttr.in/Berlin?lang=de"
```

## Specific Location
```bash
curl -s "wttr.in/LOCATION?format=3"
```

## Machine-Readable
```bash
curl -s "wttr.in/Berlin?format=j1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['current_condition'][0], indent=2))"
```

## Notes
- Default city: Berlin (unless user specifies another)
- Language detection: use `?lang=de` for German users
- For multi-day: use `wttr.in/CITY?3` for 3-day forecast
