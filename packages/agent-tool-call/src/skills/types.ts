export type SkillDoc = {
  id: string
  name: string
  description?: string
  sourcePath: string
  body: string
  allowedTools: string[]
}

export type SkillSelection = {
  active: SkillDoc[]
  unknownRequested: string[]
}
