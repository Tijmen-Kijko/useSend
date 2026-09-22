import { z } from "zod";

export const apiKeySchema = z.object({
  name: z.string({ required_error: "Name is required" }).min(1, {
    message: "Name is required",
  }),
  permission: z.enum(["SENDING", "FULL"]),
  domainId: z.string().optional(),
});

export type ApiKeyFormValues = z.infer<typeof apiKeySchema>;

export const DEFAULT_API_KEY_FORM_VALUES: ApiKeyFormValues = {
  name: "",
  permission: "SENDING",
  domainId: "all",
};

export function toCreateApiKeyInput(values: ApiKeyFormValues) {
  return {
    name: values.name,
    permission: values.permission,
    domainId:
      values.domainId === "all" || values.domainId === undefined
        ? undefined
        : Number(values.domainId),
  };
}
