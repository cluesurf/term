// The browser sandbox has no subprocess capability, so `run` surfaces an explicit error result (code -1) rather than a
// silent no-op. A program that needs to run a process must do so on a server target. Reached only through the public
// run API.
const runner = {
  run: async (
    _command: string,
    _argumentList: string[],
  ): Promise<{ code: number; output: string; error: string }> => ({
    code: -1,
    output: '',
    error: 'subprocess is not available in the browser',
  }),
}
