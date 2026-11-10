import { getInvitePreview } from "@/actions/invitations";
import { createClient } from "@/lib/supabase/server";
import InviteClient from "./InviteClient";

export const metadata = { title: "Join your team — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: { token: string } }) {
  const preview = await getInvitePreview(params.token);
  const { data } = await createClient().auth.getUser();
  return <InviteClient token={params.token} preview={preview} signedInEmail={data.user?.email ?? null} />;
}
