import { z } from "zod";

const aDiff = z.object({
    path: z.string(),
    position: z.number(),
    line: z.number(),
    change: z.object({
        type: z.string(),
        add: z.boolean(),
        ln: z.number(),
        content: z.string(),
        relativePosition: z.number(),
    }),
    previously: z.union([z.string(), z.null()]),
    suggestions: z.union([z.string(), z.null()]),
});

const diffPayloadSchema = z.object({
    commentsToAdd: z.array(aDiff),
});

const diffPayloadSchemaWithRequiredSuggestions = diffPayloadSchema.extend({
    commentsToAdd: z.array(aDiff.extend({ suggestions: z.string() })),
});

export { aDiff, diffPayloadSchema, diffPayloadSchemaWithRequiredSuggestions };
