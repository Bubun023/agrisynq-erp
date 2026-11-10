"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { acceptInvitationNewUser, acceptInvitationSignedIn, type InvitePreview } from "@/actions/invitations";

const box = "w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4";
const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm";

export default function InviteClient({ token, preview, signedInEmail }: { token: string; preview: InvitePreview; signedInEmail: string | null }) {
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  if (!preview.found || !preview.usable) {
    return (
      <div className={box}>
        <h1 className="text-lg font-semibold text-slate-900">Invitation unavailable</h1>
        <p className="text-sm text-slate-600">{preview.reason ?? "This invitation cannot be used."}</p>
        <Link href="/login" className="text-sm text-emerald-700 underline">Go to sign in</Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className={box}>
        <h1 className="text-lg font-semibold text-slate-900">You&apos;re in</h1>
        <p className="text-sm text-slate-600">Your access to <b>{preview.company}</b> as <b>{preview.role}</b> is ready.</p>
        <Link href="/login" className="inline-block rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white">Sign in</Link>
      </div>
    );
  }

  const sameEmail = signedInEmail && signedInEmail.toLowerCase() === preview.email?.toLowerCase();

  return (
    <div className={box}>
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Join {preview.company}</h1>
        <p className="mt-1 text-sm text-slate-600">You have been invited as <b>{preview.role}</b>.</p>
      </div>

      {sameEmail ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">You are signed in as <b>{signedInEmail}</b>.</p>
          <button disabled={pending} className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => start(async () => { const r = await acceptInvitationSignedIn(token); if (r.error) setError(r.error); else setDone(true); })}>
            {pending ? "Joining…" : "Accept invitation"}
          </button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (pw !== pw2) { setError("The two passwords do not match."); return; }
          start(async () => { const r = await acceptInvitationNewUser(token, name, pw); if (r.error) setError(r.error); else setDone(true); });
        }}>
          {signedInEmail && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">You are signed in as {signedInEmail}, but this invitation is for {preview.email}. Sign out first if that is your account.</p>}
          <label className="block text-sm">Email<input className={`${input} bg-slate-50`} value={preview.email} readOnly /></label>
          <label className="block text-sm">Your full name<input className={input} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></label>
          <label className="block text-sm">Choose a password<input type="password" className={input} value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} autoComplete="new-password" /></label>
          <label className="block text-sm">Repeat the password<input type="password" className={input} value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={8} autoComplete="new-password" /></label>
          <button disabled={pending} className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{pending ? "Creating your account…" : "Create account and join"}</button>
          <p className="text-xs text-slate-500">Already have an account with this email? <Link href={`/login?redirectTo=/invite/${token}`} className="underline">Sign in</Link> and open this link again.</p>
        </form>
      )}
      {error && <p className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
    </div>
  );
}
