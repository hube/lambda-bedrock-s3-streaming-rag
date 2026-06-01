import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function probeDocker(): Promise<boolean> {
  if (process.env.SKIP_INTEGRATION === "1") return false;
  try {
    await execAsync("docker info");
    return true;
  } catch {
    return false;
  }
}

export const dockerAvailable = await probeDocker();
