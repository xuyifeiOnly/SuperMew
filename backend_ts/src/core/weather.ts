import { env } from '../config.js';
import type { JsonObject } from './shared.js';

export const getCurrentWeather = async (location: string, extensions = 'base'): Promise<string> => {
  if (!location) {
    return 'location 参数不能为空';
  }
  if (!['base', 'all'].includes(extensions)) {
    return 'extensions 参数错误，请输入 base 或 all';
  }
  if (!env.amapWeatherApi || !env.amapApiKey) {
    return '天气服务未配置（缺少 AMAP_WEATHER_API 或 AMAP_API_KEY）';
  }

  try {
    const url = new URL(env.amapWeatherApi);
    url.searchParams.set('key', env.amapApiKey);
    url.searchParams.set('city', location);
    url.searchParams.set('extensions', extensions);
    url.searchParams.set('output', 'json');
    const response = await fetch(url.toString());
    const payload = (await response.json()) as JsonObject;
    if (String(payload.status ?? '') !== '1') {
      return `查询失败：${String(payload.info ?? '未知错误')}`;
    }
    if (extensions === 'base') {
      const live = (payload.lives as JsonObject[] | undefined)?.[0] ?? {};
      return [
        `【${String(live.city ?? location)} 实时天气】`,
        `天气状况：${String(live.weather ?? '未知')}`,
        `温度：${String(live.temperature ?? '未知')}℃`,
        `湿度：${String(live.humidity ?? '未知')}%`,
        `风向：${String(live.winddirection ?? '未知')}`,
        `风力：${String(live.windpower ?? '未知')}级`,
        `更新时间：${String(live.reporttime ?? '未知')}`,
      ].join('\n');
    }
    const forecast = (payload.forecasts as JsonObject[] | undefined)?.[0] ?? {};
    const today = (forecast.casts as JsonObject[] | undefined)?.[0] ?? {};
    return [
      `【${String(forecast.city ?? location)} 天气预报】`,
      `更新时间：${String(forecast.reporttime ?? '未知')}`,
      '',
      '今日天气：',
      `白天：${String(today.dayweather ?? '未知')}`,
      `夜间：${String(today.nightweather ?? '未知')}`,
      `气温：${String(today.nighttemp ?? '未知')}~${String(today.daytemp ?? '未知')}℃`,
    ].join('\n');
  } catch (error) {
    return `错误：天气服务请求失败 - ${error instanceof Error ? error.message : String(error)}`;
  }
};
