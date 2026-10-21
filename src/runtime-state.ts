/**
 * Runtime state shared by the server and the routes.
 * Used to refuse new streams while the process is shutting down.
 */
export const runtimeState = {
  shuttingDown: false,
};

export function beginShutdown(): void {
  runtimeState.shuttingDown = true;
}
