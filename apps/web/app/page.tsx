export default function Home() {
  return (
    <section className="max-w-2xl space-y-4">
      <h1 className="text-3xl font-semibold">Put your API on the agent market</h1>
      <p className="text-muted-foreground">
        Hand over a link to your OpenAPI description, prove you own the API, then approve a price and a promise.
        AI agents buy credits from you directly, and they only spend a credit when your response keeps the promise.
      </p>
      <a href="/login" className="inline-block rounded-md bg-primary px-4 py-2 text-primary-foreground">
        Get started
      </a>
    </section>
  );
}
