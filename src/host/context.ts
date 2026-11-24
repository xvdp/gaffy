/** @xvdp
 * Request context of the view whose build is running, through the provider's asynchronous calls (the provider is
 * shared by every open view): external code wanted (`view.external`, else setting gaffy.includeExternal).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const viewScope = new AsyncLocalStorage<{ external: boolean }>();
