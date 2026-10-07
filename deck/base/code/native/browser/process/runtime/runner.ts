// The browser sandbox has no subprocess capability, so `run` surfaces an explicit error result (code -1) rather than a
// silent no-op. A program that needs to run a process must do so on a server target. `directory` and `environment` are
// accepted and ignored. Reached only through the public run API.
const runner = {
  run: async (
    _command: string,
    _argumentList: string[],
    _directory: string,
    _environment: Map<string, string> | undefined,
  ): Promise<{ code: number; output: string; error: string; signal: number }> => ({
    code: -1,
    output: '',
    error: 'subprocess is not available in the browser',
    signal: 0,
  }),
  attached: async (
    _command: string,
    _argumentList: string[],
    _directory: string,
    _environment: Map<string, string> | undefined,
  ): Promise<number> => -1,
  withInput: async (
    _command: string,
    _argumentList: string[],
    _input: string,
    _directory: string,
    _environment: Map<string, string> | undefined,
  ): Promise<{ code: number; output: string; error: string; signal: number }> => ({
    code: -1,
    output: '',
    error: 'subprocess is not available in the browser',
    signal: 0,
  }),
}
