import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";

type Item = { id: string; name: string; packed: boolean };

const starter: Item[] = [
  { id: "1", name: "Passport", packed: true },
  { id: "2", name: "Phone charger", packed: false },
  { id: "3", name: "Sunglasses", packed: false },
  { id: "4", name: "Swimsuit", packed: true },
  { id: "5", name: "Toothbrush", packed: false },
];

export default function App() {
  const [items, setItems] = useState<Item[]>(starter);
  const [draft, setDraft] = useState("");

  const packedCount = items.filter((item) => item.packed).length;
  const progress = items.length === 0 ? 0 : packedCount / items.length;

  function addItem() {
    const name = draft.trim();
    if (!name) return;
    setItems((current) => [...current, { id: String(Date.now()), name, packed: false }]);
    setDraft("");
  }

  function togglePacked(id: string) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, packed: !item.packed } : item)),
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>Packing list</Text>
        <Text style={styles.subtitle} testID="progress-label">
          {packedCount} of {items.length} packed
        </Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      </View>

      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          placeholder="Add an item"
          placeholderTextColor="#7b8794"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={addItem}
          accessibilityLabel="New item name"
          testID="new-item-input"
        />
        <Pressable style={styles.addButton} onPress={addItem} accessibilityRole="button" testID="add-button">
          <Text style={styles.addButtonText}>Add</Text>
        </Pressable>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => togglePacked(item.id)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: item.packed }}
            accessibilityLabel={item.name}
            testID={`item-${item.name}`}
          >
            <View style={[styles.check, item.packed && styles.checkOn]}>
              {item.packed && <Text style={styles.checkMark}>✓</Text>}
            </View>
            <Text style={[styles.itemName, item.packed && styles.itemPacked]}>{item.name}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f4f6f8" },
  header: { backgroundColor: "#1f3a5f", paddingTop: 56, paddingBottom: 20, paddingHorizontal: 20 },
  title: { color: "#fff", fontSize: 28, fontWeight: "700" },
  subtitle: { color: "#c9d6e3", fontSize: 15, marginTop: 4 },
  progressTrack: { height: 8, backgroundColor: "#2f527d", borderRadius: 4, marginTop: 12, overflow: "hidden" },
  progressFill: { height: 8, backgroundColor: "#5ad1a0", borderRadius: 4 },
  addRow: { flexDirection: "row", gap: 8, padding: 16 },
  input: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#dde3ea",
  },
  addButton: { backgroundColor: "#1f3a5f", borderRadius: 10, paddingHorizontal: 18, justifyContent: "center" },
  addButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  list: { paddingHorizontal: 16, paddingBottom: 32, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 12,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#9aa8b6",
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: "#5ad1a0", borderColor: "#5ad1a0" },
  checkMark: { color: "#fff", fontSize: 14, fontWeight: "700" },
  itemName: { flex: 1, fontSize: 17, color: "#1d2733" },
  itemPacked: { color: "#9aa8b6", textDecorationLine: "line-through" },
});
