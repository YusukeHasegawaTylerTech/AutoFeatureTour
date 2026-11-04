// Code step: checks how many tasks the list shows (all of them, or only completed ones).
//   { "use": "todo-count", "with": { "count": 2, "completed": true }, "criterion": 2 }
export default async function todoCount({ page, args, ctx }) {
  const items = page.getByTestId('todo-item');
  const shown = args.completed ? items.filter({ has: page.locator('input.toggle:checked') }) : items;
  const n = await shown.count();
  ctx.check(n === Number(args.count), `expected ${args.count} ${args.completed ? 'completed ' : ''}task(s) in the list, found ${n}`);
  await ctx.tour.moveTo(page.getByTestId('todo-count'), { steps: 25 });
}
