"use client";

import { useFormState, useFormStatus } from "react-dom";
import { signInAction, type AuthActionState } from "@/actions/auth";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const initialState: AuthActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      id="btn-signin"
      type="submit"
      disabled={pending}
      className={cn(
        "w-full flex items-center justify-center gap-2",
        "px-4 py-2.5 rounded-md text-sm font-medium",
        "bg-leaf-600 text-white",
        "hover:bg-leaf-700 active:bg-leaf-800",
        "transition-colors shadow-sm",
        "disabled:opacity-60 disabled:cursor-not-allowed"
      )}
    >
      {pending ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          Signing in…
        </>
      ) : (
        "Sign in"
      )}
    </button>
  );
}

export default function LoginPage() {
  const [state, formAction] = useFormState(signInAction, initialState);
  const [showPassword, setShowPassword] = useState(false);
  const [redirectTo, setRedirectTo] = useState("");
  useEffect(() => { setRedirectTo(new URLSearchParams(window.location.search).get("redirectTo") ?? ""); }, []);

  return (
    <div className="w-full max-w-md animate-fade-in">
      {/* Brand header */}
      <div className="text-center mb-8 flex flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-full.svg"
          alt="FertiLedger ERP"
          className="h-20 w-auto select-none"
        />
        <p className="text-xs text-ink-faint tracking-wide">
          Stock. Accounts. Compliance. Connected.
        </p>
      </div>

      {/* Card */}
      <div className="card p-8">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-ink">Sign in</h2>
          <p className="text-sm text-ink-muted mt-0.5">
            Enter your credentials to access FertiLedger ERP
          </p>
        </div>

        <form action={formAction} className="space-y-5" noValidate>
        <input type="hidden" name="redirectTo" value={redirectTo} />
          {/* Global error */}
          {state.error && (
            <div
              role="alert"
              className="flex items-start gap-2 text-sm text-danger-600 bg-danger-50 border border-danger-100 rounded-md px-3 py-2.5"
            >
              <span className="mt-px">⚠</span>
              <span>{state.error}</span>
            </div>
          )}

          {/* Email */}
          <div>
            <label htmlFor="email" className="form-label">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              className={cn(
                "w-full px-3 py-2 text-sm rounded-md border shadow-input",
                "bg-surface-card text-ink placeholder:text-ink-faint",
                "transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-leaf-500 focus:border-transparent",
                state.fieldErrors?.email
                  ? "border-danger-500"
                  : "border-surface-border hover:border-ink-faint"
              )}
              placeholder="you@company.com"
            />
            {state.fieldErrors?.email && (
              <p className="form-error">{state.fieldErrors.email[0]}</p>
            )}
          </div>

          {/* Password */}
          <div>
            <label htmlFor="password" className="form-label">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                className={cn(
                  "w-full px-3 py-2 pr-10 text-sm rounded-md border shadow-input",
                  "bg-surface-card text-ink placeholder:text-ink-faint",
                  "transition-colors",
                  "focus:outline-none focus:ring-2 focus:ring-leaf-500 focus:border-transparent",
                  state.fieldErrors?.password
                    ? "border-danger-500"
                    : "border-surface-border hover:border-ink-faint"
                )}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink-muted transition-colors"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
            {state.fieldErrors?.password && (
              <p className="form-error">{state.fieldErrors.password[0]}</p>
            )}
          </div>

          {/* Submit */}
          <SubmitButton />
        </form>
      </div>

      {/* Footer */}
      <p className="text-center text-xs text-ink-faint mt-6">
        FertiLedger ERP · Agricultural Trade &amp; Compliance System
      </p>
    </div>
  );
}