// Dashboard component\nimport { featureFlags } from "./feature-config";\n\nexport function Dashboard() {\n  if (!featureFlags.enableNewDashboard) return null;\n  return "New Dashboard";\n}
