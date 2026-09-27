import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// 16. Sign-out and an account switch clear the Shadowing cache prefix and
// nothing else in sessionStorage.
let authCallback: ((event: string, session: { user: { id: string } } | null) => void) | null = null;
const signOutMock = jest.fn(async () => ({ error: null }));

jest.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-a" } } }),
      onAuthStateChange: (cb: typeof authCallback) => {
        authCallback = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signOut: signOutMock,
    },
  }),
}));
jest.mock("@/components/AuthModal", () => function AuthModal() {
  return null;
});

import { AuthProvider, useAuth } from "@/context/auth";

function Probe() {
  const { user, signOut } = useAuth();
  return (
    <>
      <span>{user?.id ?? "none"}</span>
      <button onClick={() => void signOut()}>sign out</button>
    </>
  );
}

function seed() {
  window.sessionStorage.setItem("dictation.shadowing.v2.user-a.vid.tr.round", "{}");
  window.sessionStorage.setItem("dictation.shadowing-evaluations.vid.tr", "{}");
  window.sessionStorage.setItem("dictation.active-session.vid", "{}");
}

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => window.sessionStorage.clear());

it("signOut clears the Shadowing cache prefix and keeps unrelated data", async () => {
  const { findByText, getByText } = mount();
  await findByText("user-a");
  seed();
  await act(async () => {
    fireEvent.click(getByText("sign out"));
  });
  await waitFor(() => expect(signOutMock).toHaveBeenCalled());
  await waitFor(() => expect(Object.keys(window.sessionStorage)).toEqual(["dictation.active-session.vid"]));
});

it("another account signing in on the same tab clears the previous account's cache", async () => {
  const { findByText } = mount();
  await findByText("user-a");
  seed();
  act(() => authCallback!("SIGNED_IN", { user: { id: "user-b" } }));
  await waitFor(() => expect(window.sessionStorage.getItem("dictation.shadowing.v2.user-a.vid.tr.round")).toBeNull());
  expect(window.sessionStorage.getItem("dictation.active-session.vid")).toBe("{}");
});

it("a token refresh for the SAME user does not clear anything", async () => {
  const { findByText } = mount();
  await findByText("user-a");
  seed();
  act(() => authCallback!("TOKEN_REFRESHED", { user: { id: "user-a" } }));
  expect(window.sessionStorage.length).toBe(3);
});
