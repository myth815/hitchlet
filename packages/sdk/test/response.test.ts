import { describe, expect, it } from "vitest";
import {
  AcquireRequestSchema,
  ApiErrorResponseSchema,
  ImageSelectorSchema,
} from "@hitchlet/contracts";
import { PowerSchemas } from "@hitchlet/contracts/admin";
import { parseResponse } from "../src/response.js";
import { z } from "../../contracts/node_modules/zod/index.js";

describe("compatible response decoding", () => {
  it("accepts additive fields at the root and inside known objects", () => {
    const parsed = parseResponse(ApiErrorResponseSchema, {
      extension: { trace: "root" },
      error: {
        code: "TEMPORARY",
        message: "try again",
        details: {},
        retryable: true,
        requestId: "00000000-0000-4000-8000-000000000001",
        vendor: { trace: "nested" },
      },
    });

    expect(parsed).toEqual({
      error: {
        code: "TEMPORARY",
        message: "try again",
        details: {},
        retryable: true,
        requestId: "00000000-0000-4000-8000-000000000001",
      },
    });
  });

  it("still rejects missing required values and invalid known values", () => {
    expect(() =>
      parseResponse(ApiErrorResponseSchema, {
        error: {
          code: "",
          message: "try again",
          details: {},
          retryable: true,
          requestId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    ).toThrow();
    expect(() =>
      parseResponse(ApiErrorResponseSchema, {
        error: {
          code: "TEMPORARY",
          message: "try again",
          details: {},
          requestId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    ).toThrow();
    expect(() =>
      parseResponse(ApiErrorResponseSchema, {
        error: {
          code: "TEMPORARY",
          message: "try again",
          details: {},
          retryable: "yes",
          requestId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    ).toThrow();
  });

  it("does not prune valid fields reported as unknown by another union branch", () => {
    const selectors = parseResponse(ImageSelectorSchema.array(), [
      {
        versionId: "00000000-0000-4000-8000-000000000001",
        extension: true,
      },
      {
        imageId: "00000000-0000-4000-8000-000000000002",
        alias: "stable",
        extension: true,
      },
    ]);

    expect(selectors).toEqual([
      { versionId: "00000000-0000-4000-8000-000000000001" },
      { imageId: "00000000-0000-4000-8000-000000000002", alias: "stable" },
    ]);
  });

  it("uses one compatible branch for an overlapping ordinary union", () => {
    const overlapping = z.union([
      z
        .object({
          kind: z.string(),
          common: z.string(),
          left: z.string().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.string(),
          common: z.string(),
          right: z.string().optional(),
        })
        .strict(),
    ]);
    const parsed = parseResponse(overlapping, {
      kind: "shared",
      common: "valid",
      left: "keep this known field",
      right: "an extension to the first branch",
      extension: true,
    });

    expect(parsed).toEqual({
      kind: "shared",
      common: "valid",
      left: "keep this known field",
    });
  });

  it("accepts extensions in nested discriminated union members and arrays", () => {
    const advances = parseResponse(
      PowerSchemas.PowerPreviewAdvanceSchema.array(),
      [
        {
          expectedVersion: 1,
          extension: true,
          event: {
            kind: "wake",
            provisionDeadlineMs: 60_000,
            extension: true,
          },
        },
      ],
    );

    expect(advances).toEqual([
      {
        expectedVersion: 1,
        event: { kind: "wake", provisionDeadlineMs: 60_000 },
      },
    ]);
  });

  it("keeps request schemas strict", () => {
    expect(() =>
      AcquireRequestSchema.parse({
        image: {
          versionId: "00000000-0000-4000-8000-000000000001",
          extension: true,
        },
        resources: { cpuMillis: 1, memoryMiB: 1, scratchMiB: 0 },
        networkProfileId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toThrow();
  });
});
