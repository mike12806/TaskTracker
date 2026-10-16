import { describe, it, expect, afterEach } from "vitest";
import { BUILD_ID_REQUEST } from "../src/serviceWorkerContract";
import { updateChangesBuild, workerBuildId } from "../src/utils/workerBuild";

/**
 * A worker that answers the build question with `buildId`, or says nothing at
 * all — which is what a worker from a build predating the message does.
 */
function installWorker(buildId: string | null): void {
  const worker = {
    postMessage(message: { type?: string }, transfer: Transferable[]) {
      if (message.type !== BUILD_ID_REQUEST) return;
      if (buildId === null) return;
      const port = transfer[0] as MessagePort;
      port.postMessage({ buildId });
    },
  } as unknown as ServiceWorker;

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({ active: worker } as unknown as ServiceWorkerRegistration),
      controller: worker,
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("which build the worker is serving", () => {
  it("reads the build back from the worker", async () => {
    installWorker("abc1234");

    await expect(workerBuildId(50)).resolves.toBe("abc1234");
  });

  it("stands the reload down when the page is already running that build", async () => {
    // The ordinary case after a deploy: the launch fetched the live shell and
    // the worker finished precaching the same build a few seconds later.
    // Reloading for it is the second load the user sees for no change at all.
    installWorker(__BUILD_ID__);

    await expect(updateChangesBuild(50)).resolves.toBe(false);
  });

  it("reloads when the worker has a build this page is not running", async () => {
    installWorker("newer42");

    await expect(updateChangesBuild(50)).resolves.toBe(true);
  });

  it("reloads when the worker does not answer", async () => {
    // A worker from a build that predates the message. Unknown is treated as
    // changed: a needless reload costs a launch, a skipped one leaves the
    // device on an old build.
    installWorker(null);

    await expect(updateChangesBuild(50)).resolves.toBe(true);
  });

  it("reloads when there is no worker to ask", async () => {
    await expect(updateChangesBuild(50)).resolves.toBe(true);
  });
});
