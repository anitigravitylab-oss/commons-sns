import { test, expect } from "vitest";
import {
  DEFAULT_LOCAL_AUTO_RELOAD_MS,
  MIN_LOCAL_AUTO_RELOAD_MS,
  MAX_LOCAL_AUTO_RELOAD_MS,
  normalizeAutoReloadMs,
  resolveAutoReloadMs,
} from "./auto-reload";

test("constants have expected defaults", () => {
  expect(DEFAULT_LOCAL_AUTO_RELOAD_MS).toBe(2000);
  expect(MIN_LOCAL_AUTO_RELOAD_MS).toBe(500);
  expect(MAX_LOCAL_AUTO_RELOAD_MS).toBe(60000);
});

test("normalizeAutoReloadMs returns null for missing or blank input", () => {
  expect(normalizeAutoReloadMs(undefined)).toBe(null);
  expect(normalizeAutoReloadMs(null)).toBe(null);
  expect(normalizeAutoReloadMs("")).toBe(null);
  expect(normalizeAutoReloadMs("   ")).toBe(null);
});

test("normalizeAutoReloadMs treats 0 as explicit disable", () => {
  expect(normalizeAutoReloadMs("0")).toBe(0);
});

test("normalizeAutoReloadMs clamps to the valid range", () => {
  expect(normalizeAutoReloadMs("500")).toBe(MIN_LOCAL_AUTO_RELOAD_MS);
  expect(normalizeAutoReloadMs("60000")).toBe(MAX_LOCAL_AUTO_RELOAD_MS);
  expect(normalizeAutoReloadMs("100")).toBe(MIN_LOCAL_AUTO_RELOAD_MS);
  expect(normalizeAutoReloadMs("99999")).toBe(MAX_LOCAL_AUTO_RELOAD_MS);
  expect(normalizeAutoReloadMs("2000")).toBe(2000);
});

test("normalizeAutoReloadMs truncates fractional milliseconds", () => {
  expect(normalizeAutoReloadMs("2000.7")).toBe(2000);
});

test("normalizeAutoReloadMs rejects non-numeric and negative input", () => {
  expect(normalizeAutoReloadMs("abc")).toBe(null);
  expect(normalizeAutoReloadMs("-1")).toBe(null);
});

test("resolveAutoReloadMs is always disabled in production", () => {
  expect(resolveAutoReloadMs({ isDev: false, envValue: "5000", queryValue: "3000" })).toBe(0);
  expect(resolveAutoReloadMs({ isDev: false, envValue: undefined, queryValue: null })).toBe(0);
});

test("resolveAutoReloadMs falls back to the default when nothing is configured", () => {
  expect(resolveAutoReloadMs({ isDev: true, envValue: undefined, queryValue: null })).toBe(
    DEFAULT_LOCAL_AUTO_RELOAD_MS,
  );
});

test("resolveAutoReloadMs reads the environment value in dev", () => {
  expect(resolveAutoReloadMs({ isDev: true, envValue: "5000", queryValue: null })).toBe(5000);
});

test("resolveAutoReloadMs prefers the URL query over the environment value", () => {
  expect(resolveAutoReloadMs({ isDev: true, envValue: "5000", queryValue: "3000" })).toBe(3000);
});

test("resolveAutoReloadMs disables via ?autoReloadMs=0", () => {
  expect(resolveAutoReloadMs({ isDev: true, envValue: "5000", queryValue: "0" })).toBe(0);
});

test("resolveAutoReloadMs ignores an invalid query and falls back to the environment value", () => {
  expect(resolveAutoReloadMs({ isDev: true, envValue: "5000", queryValue: "abc" })).toBe(5000);
});

test("resolveAutoReloadMs falls back to the default when the environment value is invalid", () => {
  expect(resolveAutoReloadMs({ isDev: true, envValue: "abc", queryValue: null })).toBe(DEFAULT_LOCAL_AUTO_RELOAD_MS);
});
