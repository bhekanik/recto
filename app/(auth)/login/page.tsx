"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [isSignUp, setIsSignUp] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setPending(true);

		try {
			if (isSignUp) {
				const result = await authClient.signUp.email({
					email,
					password,
					name: name || email.split("@")[0] || "Writer",
				});
				if (result.error) {
					setError(result.error.message ?? "Sign up failed");
					return;
				}
			} else {
				const result = await authClient.signIn.email({ email, password });
				if (result.error) {
					setError(result.error.message ?? "Sign in failed");
					return;
				}
			}
			router.push("/");
			router.refresh();
		} finally {
			setPending(false);
		}
	}

	return (
		<main className="flex min-h-dvh flex-col items-center justify-center px-[var(--space-6)]">
			<div className="w-full max-w-sm space-y-[var(--space-6)]">
				<div className="space-y-[var(--space-2)] text-center">
					<h1 className="text-[length:var(--text-display)] leading-[var(--leading-display)] font-semibold text-[var(--color-ink-secondary)]">
						Recto
					</h1>
					<p className="text-[length:var(--text-ui)] text-muted-foreground">
						{isSignUp ? "Create your account" : "Sign in to your studio"}
					</p>
				</div>

				<Card>
					<CardHeader className="sr-only">
						<CardTitle>{isSignUp ? "Sign up" : "Sign in"}</CardTitle>
						<CardDescription>Recto writing studio</CardDescription>
					</CardHeader>
					<CardContent>
						<form onSubmit={handleSubmit} className="space-y-[var(--space-4)]">
							{isSignUp && (
								<div className="space-y-[var(--space-2)]">
									<Label htmlFor="name">Name</Label>
									<Input
										id="name"
										type="text"
										value={name}
										onChange={(e) => setName(e.target.value)}
										autoComplete="name"
									/>
								</div>
							)}

							<div className="space-y-[var(--space-2)]">
								<Label htmlFor="email">Email</Label>
								<Input
									id="email"
									type="email"
									required
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									autoComplete="email"
								/>
							</div>

							<div className="space-y-[var(--space-2)]">
								<Label htmlFor="password">Password</Label>
								<Input
									id="password"
									type="password"
									required
									minLength={8}
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									autoComplete={isSignUp ? "new-password" : "current-password"}
								/>
							</div>

							{error && (
								<Alert variant="destructive">
									<AlertDescription>{error}</AlertDescription>
								</Alert>
							)}

							<Button type="submit" disabled={pending} className="w-full">
								{pending ? "…" : isSignUp ? "Create account" : "Sign in"}
							</Button>
						</form>
					</CardContent>
				</Card>

				<p className="text-center text-[length:var(--text-ui-sm)] text-muted-foreground">
					{isSignUp ? "Already have an account?" : "First time here?"}{" "}
					<Button
						type="button"
						variant="link"
						className="h-auto p-0 text-[var(--color-accent-2)]"
						onClick={() => {
							setIsSignUp(!isSignUp);
							setError(null);
						}}
					>
						{isSignUp ? "Sign in" : "Create account"}
					</Button>
				</p>
			</div>
		</main>
	);
}
