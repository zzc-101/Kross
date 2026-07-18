import { describe, expect, it } from 'vitest';

import { conductorTaskPlanSchema } from './conductorPlan';

describe('conductorTaskPlanSchema', () => {
  it('accepts an acyclic dependency graph', () => {
    expect(
      conductorTaskPlanSchema.parse({
        goal: 'ship change',
        tasks: [
          { id: 'inspect', title: 'inspect', prompt: 'inspect' },
          {
            id: 'implement',
            title: 'implement',
            prompt: 'implement',
            dependsOn: ['inspect']
          },
          {
            id: 'docs',
            title: 'docs',
            prompt: 'document',
            dependsOn: ['implement']
          }
        ]
      }).tasks[1]?.dependsOn
    ).toEqual(['inspect']);
  });

  it.each([
    {
      name: 'duplicate ids',
      tasks: [
        { id: 'same', title: 'one', prompt: 'one' },
        { id: 'same', title: 'two', prompt: 'two' }
      ]
    },
    {
      name: 'unknown dependency',
      tasks: [
        {
          id: 'task',
          title: 'task',
          prompt: 'task',
          dependsOn: ['missing']
        }
      ]
    },
    {
      name: 'cycle',
      tasks: [
        { id: 'a', title: 'a', prompt: 'a', dependsOn: ['b'] },
        { id: 'b', title: 'b', prompt: 'b', dependsOn: ['a'] }
      ]
    }
  ])('rejects $name', ({ tasks }) => {
    expect(
      conductorTaskPlanSchema.safeParse({ goal: 'invalid', tasks }).success
    ).toBe(false);
  });
});
