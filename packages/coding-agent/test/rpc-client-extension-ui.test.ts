import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";

const clients: RpcClient[] = [];
const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-extension-ui-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.stop()));
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient extension UI", () => {
	test("emits requests and writes their responses", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
let buffer = "";
process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Allow?", options: ["Allow", "Block"] }) + "\\n");
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		const record = JSON.parse(line);
		if (record.type === "extension_ui_response") {
			process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ack", method: "notify", message: record.value }) + "\\n");
		}
	}
});
`),
		});
		clients.push(client);

		const selectRequest = new Promise<RpcExtensionUIRequest>((resolve) => {
			const unsubscribe = client.onEvent((event) => {
				if (event.type === "extension_ui_request" && event.method === "select") {
					unsubscribe();
					resolve(event);
				}
			});
		});
		const acknowledgement = new Promise<RpcExtensionUIRequest>((resolve) => {
			const unsubscribe = client.onEvent((event) => {
				if (event.type === "extension_ui_request" && event.method === "notify") {
					unsubscribe();
					resolve(event);
				}
			});
		});

		await client.start();
		expect((await selectRequest).id).toBe("ui-1");
		client.respondExtensionUI({ type: "extension_ui_response", id: "ui-1", value: "Allow" });
		const response = await acknowledgement;
		expect(response.method === "notify" && response.message).toBe("Allow");
	});
});
