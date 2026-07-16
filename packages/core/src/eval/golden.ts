import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
import type { ExpectedRoute, GoldenCase } from './types.js';

const EXPECTED_ROUTES = new Set<ExpectedRoute>(['codex', 'claude', 'escalate', 'any']);

export async function loadGoldenCases(dir: string): Promise<GoldenCase[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort();

  return Promise.all(
    files.map(async (file) => {
      const path = join(dir, file);
      const raw = await readFile(path, 'utf-8');
      const { data, content } = matter(raw);

      const expectedRoute = (data.expectedRoute ?? 'any') as ExpectedRoute;
      if (!EXPECTED_ROUTES.has(expectedRoute)) {
        throw new Error(`${path}: invalid expectedRoute '${String(data.expectedRoute)}'`);
      }

      const { content: contentWithoutStub, stubOutput } = extractStubOutput(content);
      const { title, body } = extractTitleAndBody(contentWithoutStub, path);

      return {
        id: typeof data.id === 'string' && data.id.trim() ? data.id : basename(file, '.md'),
        title,
        body,
        expectedRoute,
        deterministicOnly: data.deterministicOnly ?? false,
        rubric: Array.isArray(data.rubric) ? data.rubric.map(String) : [],
        minRubricScore: typeof data.minRubricScore === 'number' ? data.minRubricScore : 7,
        ...(stubOutput !== undefined ? { stubOutput } : {}),
        ...(typeof data.constitution === 'string' && data.constitution.trim()
          ? { constitution: data.constitution }
          : {}),
        path,
      };
    }),
  );
}

function extractStubOutput(content: string): { content: string; stubOutput?: string } {
  const stubMatch = content.match(/```stub-output\r?\n([\s\S]*?)\r?\n```/);
  if (!stubMatch) return { content };

  return {
    content: content.replace(stubMatch[0], '').trim(),
    stubOutput: stubMatch[1],
  };
}

function extractTitleAndBody(content: string, path: string): { title: string; body: string } {
  const titleMatch = content.match(/^# (.+)$/m);
  if (!titleMatch || titleMatch.index === undefined) {
    throw new Error(`${path}: missing first '# ' issue title heading`);
  }

  const titleLineEnd = content.indexOf('\n', titleMatch.index);
  const bodyStart = titleLineEnd === -1 ? content.length : titleLineEnd + 1;
  return {
    title: titleMatch[1].trim(),
    body: content.slice(bodyStart).trim(),
  };
}
