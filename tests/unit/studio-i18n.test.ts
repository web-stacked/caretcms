import { describe, expect, it } from "vitest";
import { resolveStudioDictionary } from "../../packages/core/src/runtime/i18n";
import { serializeJsonForScript } from "../../packages/core/src/runtime/views/studio-layout";

describe("Studio localization", () => {
  it("ships complete English and Spanish dictionaries", () => {
    const english = resolveStudioDictionary("en");
    const spanish = resolveStudioDictionary("es");

    expect(Object.keys(spanish)).toEqual(Object.keys(english));
    expect(english["entry.saveLive"]).toBe("Save live");
    expect(spanish["entry.saveLive"]).toBe("Guardar en vivo");
    expect(spanish["collection.search"]).toBe("Buscar");
  });

  it("applies integration dictionary overrides after the locale", () => {
    const messages = resolveStudioDictionary("es", {
      "entry.saveLive": "Publicar ahora",
    });
    expect(messages["entry.saveLive"]).toBe("Publicar ahora");
    expect(messages["entry.delete"]).toBe("Eliminar");
  });

  it("serializes dictionary overrides without allowing script termination", () => {
    const serialized = serializeJsonForScript({ label: "</script><script>alert(1)</script>" });
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized).label).toBe("</script><script>alert(1)</script>");
  });
});
