import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const release = (version: string, note?: string) => ({
	version: "1.2.0",
	name: "@earendil-works/pi-coding-agent",
	piConfig: { name: "pie", version, ...(note ? { note } : {}) },
});
beforeEach(() => {
	allowNetwork();
});
afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
	else process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
});

describe("Pie version checks", () => {
	it("compares versions", () => {
		expect(comparePackageVersions("0.2.0", "0.1.0")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.1.0", "0.1.0")).toBe(0);
		expect(isNewerPackageVersion("0.1.0", "0.2.0")).toBe(false);
	});
	it("checks this fork and compares product versions rather than upstream SDK versions", async () => {
		const fetchMock = vi.fn(async () => Response.json(release("0.2.0")));
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewPiVersion("0.1.0")).resolves.toEqual({ version: "0.2.0" });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://raw.githubusercontent.com/chocotan/pie/main/packages/coding-agent/package.json",
			expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": "pie/0.1.0" }) }),
		);
		await expect(checkForNewPiVersion("0.2.0")).resolves.toBeUndefined();
	});
	it.each([
		null,
		{},
		{ version: "1.3.0" },
		{ piConfig: { name: "pi", version: "1.3.0" } },
		{ piConfig: { name: "pie", version: "" } },
	])("ignores unrelated or invalid metadata: %j", async (payload) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(payload)),
		);
		await expect(getLatestPiRelease("0.1.0")).resolves.toBeUndefined();
	});
	it("retries only when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json(release("0.2.0")));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestPiRelease("0.1.0", { retry: true })).resolves.toEqual({ version: "0.2.0" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
	it("keeps automatic checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewPiVersion("0.1.0")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});
	it("takes update notes only from Pie metadata", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(release("0.2.0", " Pie changes "))),
		);
		await expect(getLatestPiRelease("0.1.0")).resolves.toEqual({ version: "0.2.0", note: "Pie changes" });
	});
	it("respects disabled automatic checks while allowing direct queries", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json(release("0.2.0")));
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewPiVersion("0.1.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
		await expect(getLatestPiVersion("0.1.0")).resolves.toBe("0.2.0");
	});
	it("formats nested network errors", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("unreachable"), { code: "ENETUNREACH" }),
			]),
		});
		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});
});
