/**
 * 讓 node:test 載入得了瀏覽器模組。
 *
 * public/ 底下的模組以 `/shared/xxx.js` 匯入 —— 那是瀏覽器的絕對網址，
 * 由 server/index.js 的 resolveStatic() 對映到 ROOT/shared。
 * Node 會把它當成檔案系統根目錄，因此測試需要同一套對映。
 *
 * 改寫模組原始碼來遷就測試是錯的方向：那會讓瀏覽器載不到。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SHARED = path.resolve(import.meta.dirname, '..', '..', 'shared');

export function resolve(specifier, context, next) {
  if (specifier.startsWith('/shared/')) {
    return next(pathToFileURL(path.join(SHARED, specifier.slice('/shared/'.length))).href, context);
  }
  return next(specifier, context);
}
