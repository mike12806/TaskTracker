import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";

/**
 * Task reminder push notifications.
 *
 * Only works on an installed (Add to Home Screen) PWA on iOS 16.4+ — a plain
 * Safari tab has no `PushManager` at all, which is what `supported` below is
 * feature-detecting, same `"x" in y` idiom `pwa.ts` and `api/client.ts` use.
 */
interface PushNotificationsContextValue {
  /** False on any browser without Web Push (desktop Safari, an un-installed iOS tab, ...). */
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  /** True while a subscribe/unsubscribe round-trip is in flight. */
  working: boolean;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

const PushNotificationsContext = createContext<PushNotificationsContextValue>({
  supported: false,
  permission: "unsupported",
  subscribed: false,
  working: false,
  subscribe: async () => {},
  unsubscribe: async () => {},
});

export function usePushNotifications(): PushNotificationsContextValue {
  return useContext(PushNotificationsContext);
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** PushManager.subscribe wants the VAPID key as bytes, not the base64url string the server hands back. */
function urlBase64ToUint8Array(base64Url: string): BufferSource {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
}

async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export function PushNotificationsProvider({ children }: { children: ReactNode }) {
  const supported = useMemo(isSupported, []);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    supported ? Notification.permission : "unsupported"
  );
  const [subscribed, setSubscribed] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!supported) return;
    getExistingSubscription()
      .then((sub) => setSubscribed(sub !== null))
      .catch(() => {});
  }, [supported]);

  const subscribe = useCallback(async () => {
    if (!supported) return;
    setWorking(true);
    try {
      // Must run as a direct result of a user gesture — iOS is strict about
      // this, which is why this is only ever called from a click handler.
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;

      const { publicKey } = await api.get<{ publicKey: string }>("/push/vapid-public-key");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.post("/push/subscribe", subscription.toJSON());
      setSubscribed(true);
    } finally {
      setWorking(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    setWorking(true);
    try {
      const subscription = await getExistingSubscription();
      if (subscription) {
        await subscription.unsubscribe();
        await api.delete(`/push/subscribe?endpoint=${encodeURIComponent(subscription.endpoint)}`);
      }
      setSubscribed(false);
    } finally {
      setWorking(false);
    }
  }, [supported]);

  return (
    <PushNotificationsContext.Provider value={{ supported, permission, subscribed, working, subscribe, unsubscribe }}>
      {children}
    </PushNotificationsContext.Provider>
  );
}
