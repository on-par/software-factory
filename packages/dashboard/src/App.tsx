const NAV_ITEMS = ['Runs', 'Issues', 'Models', 'Settings'];

export function App() {
  return (
    <div className="flex h-screen bg-canvas font-sans text-ink-900">
      <aside className="w-60 shrink-0 bg-navy-950 text-navy-200 flex flex-col">
        <nav aria-label="Primary" className="flex flex-col gap-1 p-2">
          <h1 className="px-2 py-2 leading-tight tracking-tight">
            <span className="block text-sm font-semibold text-white">On Par</span>
            <span className="block text-xs font-medium text-navy-400">Factory</span>
          </h1>
          <ul className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item}>
                <a
                  href="#"
                  className="block rounded-md px-2 py-1 text-sm font-medium text-navy-200 hover:bg-navy-800 hover:text-white"
                >
                  {item}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="flex flex-1 flex-col min-w-0">
        <header className="h-7 flex items-center border-b border-hairline bg-white px-3">
          <h2 className="text-sm font-semibold">Overview</h2>
        </header>
        <main className="flex-1 overflow-auto bg-canvas p-3">
          <p className="text-sm text-ink-400">No runs yet.</p>
        </main>
      </div>
    </div>
  );
}
