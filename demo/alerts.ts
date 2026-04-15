// Alert rules\nexport function alert(name: string, condition: () => boolean) {\n  return { name, check: condition };\n}
