/**
 * Header a service worker stamps on replies it answered from its own cache
 * rather than the network.
 *
 * The current worker never sets it — it keeps no API cache at all (see
 * `sw.ts`) — but builds that did cache stamp it, and one of those workers
 * serves the single load it takes to upgrade off it. The client keeps
 * honouring the label (`freshness.ts`) until no installed device predates
 * this build.
 */
export const FROM_CACHE_HEADER = "X-From-Cache";

/**
 * Message a page posts to the worker to ask which build it is serving.
 *
 * Sent with a `MessagePort` for the reply. It exists to answer one question:
 * the worker has just installed a new build and told the page so — is that a
 * build the page is *not already running*? A launch fetches the current shell
 * from the network (see `sw.ts`), so the ordinary case after a deploy is a
 * page that opened on the new build and a worker that finished precaching it
 * a few seconds later. Reloading for that is a second visible load of the app
 * with nothing whatsoever to show for it, which is what foregrounding the
 * installed app looked like after every deploy.
 */
export const BUILD_ID_REQUEST = "build-id";

/** The worker's answer, posted back on the port the request carried. */
export interface BuildIdReply {
  buildId: string;
}
