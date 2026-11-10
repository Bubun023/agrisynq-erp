"use server";

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { z } from "zod";

const LoginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export type AuthActionState = {
  error?: string;
  fieldErrors?: { email?: string[]; password?: string[] };
};

/**
 * Server Action: Sign in with email + password via Supabase Auth.
 * All validation is server-side. Never trust client input.
 */
export async function signInAction(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const raw = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  };

  const parsed = LoginSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    return { error: "Invalid email or password. Please try again." };
  }

  // only ever follow a path inside this app (never an absolute URL or "//host")
  const to = String(formData.get("redirectTo") ?? "");
  redirect(/^\/(?!\/)[\w\-/.?=&%]*$/.test(to) && !to.startsWith("/login") ? to : "/");
}

/**
 * Server Action: Sign out and clear session.
 */
export async function signOutAction() {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
