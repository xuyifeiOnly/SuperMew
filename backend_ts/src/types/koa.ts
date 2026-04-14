import type { Middleware, ParameterizedContext } from 'koa';
import type { CurrentUser } from '../types.js';

export interface AppState {
  user?: CurrentUser;
}

export type AppContext = ParameterizedContext<AppState>;
export type AppMiddleware = Middleware<AppState>;
