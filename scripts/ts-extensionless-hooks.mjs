// Node resolve hook for the verify scripts: lets `node --experimental-strip-types`
// load app modules that import siblings without a file extension (`./balances`),
// the way Metro and tsc resolve them.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier) && context.parentURL) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
  }
  return next(specifier, context);
}
