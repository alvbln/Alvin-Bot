/**
 * Weather Plugin — Get current weather and forecasts.
 *
 * Uses wttr.in (no API key needed).
 * Example plugin for Alvin Bot's plugin system.
 */

export default {
  name: "weather",
  description: "Weather queries via wttr.in (no API key needed)",
  version: "1.0.0",
  author: "Alvin Bot",

  commands: [
    {
      command: "weather",
      description: "Get weather (e.g. /weather Berlin)",
      handler: async (ctx, args) => {
        const location = args || "Berlin";

        try {
          await ctx.api.sendChatAction(ctx.chat.id, "typing");

          const response = await fetch(
            `https://wttr.in/${encodeURIComponent(location)}?format=j1`,
            { headers: { "User-Agent": "AlvinBot/1.0" } }
          );

          if (!response.ok) {
            await ctx.reply(`❌ Weather for "${location}" not found.`);
            return;
          }

          const data = await response.json();
          const current = data.current_condition?.[0];
          const area = data.nearest_area?.[0];

          if (!current) {
            await ctx.reply(`❌ No weather data for "${location}".`);
            return;
          }

          const areaName = area?.areaName?.[0]?.value || location;
          const country = area?.country?.[0]?.value || "";
          const temp = current.temp_C;
          const feelsLike = current.FeelsLikeC;
          const desc = current.lang_de?.[0]?.value || current.weatherDesc?.[0]?.value || "";
          const humidity = current.humidity;
          const wind = current.windspeedKmph;
          const windDir = current.winddir16Point;

          // Weather emoji based on description
          let emoji = "🌤️";
          const descLower = desc.toLowerCase();
          if (descLower.includes("regen") || descLower.includes("rain")) emoji = "🌧️";
          else if (descLower.includes("schnee") || descLower.includes("snow")) emoji = "🌨️";
          else if (descLower.includes("gewitter") || descLower.includes("thunder")) emoji = "⛈️";
          else if (descLower.includes("wolkig") || descLower.includes("cloud") || descLower.includes("bewölkt")) emoji = "☁️";
          else if (descLower.includes("sonnig") || descLower.includes("sunny") || descLower.includes("klar") || descLower.includes("clear")) emoji = "☀️";
          else if (descLower.includes("nebel") || descLower.includes("fog")) emoji = "🌫️";

          // 3-day forecast
          const forecast = data.weather?.slice(0, 3).map(day => {
            const date = day.date;
            const maxT = day.maxtempC;
            const minT = day.mintempC;
            const dayDesc = day.hourly?.[4]?.lang_de?.[0]?.value || day.hourly?.[4]?.weatherDesc?.[0]?.value || "";
            return `📅 ${date}: ${minT}°–${maxT}°C, ${dayDesc}`;
          }).join("\n") || "";

          await ctx.reply(
            `${emoji} *Weather in ${areaName}*${country ? ` (${country})` : ""}\n\n` +
            `🌡️ ${temp}°C (feels like ${feelsLike}°C)\n` +
            `${desc}\n` +
            `💧 Humidity: ${humidity}%\n` +
            `💨 Wind: ${wind} km/h ${windDir}\n` +
            (forecast ? `\n*3-Day Forecast:*\n${forecast}` : ""),
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          await ctx.reply(`❌ Error: ${err.message || err}`);
        }
      },
    },
  ],

  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name (e.g. Berlin, London)" },
        },
        required: ["location"],
      },
      execute: async (params) => {
        const location = params.location || "Berlin";
        const response = await fetch(
          `https://wttr.in/${encodeURIComponent(location)}?format=j1`,
          { headers: { "User-Agent": "AlvinBot/1.0" } }
        );

        if (!response.ok) return `Weather not found for "${location}"`;

        const data = await response.json();
        const current = data.current_condition?.[0];
        if (!current) return `No weather data for "${location}"`;

        return JSON.stringify({
          location,
          temperature: `${current.temp_C}°C`,
          feelsLike: `${current.FeelsLikeC}°C`,
          description: current.lang_de?.[0]?.value || current.weatherDesc?.[0]?.value,
          humidity: `${current.humidity}%`,
          wind: `${current.windspeedKmph} km/h ${current.winddir16Point}`,
        });
      },
    },
  ],
};
