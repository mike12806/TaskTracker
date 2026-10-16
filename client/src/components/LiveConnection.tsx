import { useEffect } from "react";
import { connectLive } from "../api/live";

/**
 * Opens the live socket for as long as the app shell is mounted.
 *
 * Renders nothing. The socket itself is a module singleton in `api/live.ts`;
 * `DataRefreshProvider` consumes its nudges. This only says "connect now" —
 * inside the auth gate, so the handshake goes out with a live Access session,
 * and outside the routes, so changing page doesn't rebuild the connection.
 */
export function LiveConnection() {
  useEffect(() => {
    connectLive(true);
    return () => connectLive(false);
  }, []);
  return null;
}
