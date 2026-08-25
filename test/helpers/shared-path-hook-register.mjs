/** 註冊 shared-path-hook，供 `node --import` 使用。見該檔說明。 */
import { register } from 'node:module';
register('./shared-path-hook.mjs', import.meta.url);
