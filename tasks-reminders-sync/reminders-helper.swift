import Foundation
import EventKit

// 任务同步提醒事项 - EventKit 辅助程序
// 用法: reminders-helper '<json>'
//   read:  {"action":"read","listName":"Obsidian"}
//   apply: {"action":"apply","listName":"Obsidian",
//           "create":[{"key","name","due"?,"url"?}],
//           "update":[{"id","name","due"?,"url"?}],
//           "complete":["id"], "delete":["id"]}
// 输出: JSON 到 stdout

struct CreateOp: Codable { let key: String; let name: String; let due: String?; let url: String?; let notes: String? }
struct UpdateOp: Codable { let id: String; let name: String; let due: String?; let url: String?; let notes: String? }
struct Payload: Codable {
    let action: String
    let listName: String
    let create: [CreateOp]?
    let update: [UpdateOp]?
    let complete: [String]?
    let delete: [String]?
}

@discardableResult
func out(_ obj: Any) -> Never {
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let s = String(data: d, encoding: .utf8) {
        FileHandle.standardOutput.write(Data(s.utf8))
    }
    Foundation.exit(0)
}

let args = CommandLine.arguments
guard args.count >= 2,
      let data = args[1].data(using: .utf8),
      let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
    out(["fatal": "bad-json"])
}

let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var granted = false
// Obsidian 的 Info.plist 只声明了旧版 NSRemindersUsageDescription，必须用旧 API
store.requestAccess(to: .reminder) { g, _ in
    granted = g
    sem.signal()
}
sem.wait()
guard granted else { out(["fatal": "denied"]) }

func findList(_ name: String) -> EKCalendar? {
    store.calendars(for: .reminder).first { $0.title == name }
}

func dueComponents(_ s: String?) -> DateComponents? {
    guard let s = s else { return nil }
    let p = s.split(separator: "-").map { Int($0) ?? 0 }
    guard p.count == 3, p[0] > 0, p[1] > 0, p[2] > 0 else { return nil }
    return DateComponents(year: p[0], month: p[1], day: p[2])
}

func dueString(_ dc: DateComponents?) -> String? {
    guard let dc = dc, let y = dc.year, let m = dc.month, let d = dc.day else { return nil }
    return String(format: "%04d-%02d-%02d", y, m, d)
}

func findReminder(_ id: String) -> EKReminder? {
    store.calendarItem(withIdentifier: id) as? EKReminder
}

if payload.action == "read" {
    guard let cal = findList(payload.listName) else {
        out(["exists": false, "reminders": [Any]()])
    }
    let pred = store.predicateForReminders(in: [cal])
    var fetched: [EKReminder] = []
    let sem2 = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: pred) { rems in
        fetched = rems ?? []
        sem2.signal()
    }
    sem2.wait()
    let items: [[String: Any]] = fetched.map { r in
        var item: [String: Any] = [
            "id": r.calendarItemIdentifier,
            "name": r.title ?? "",
            "completed": r.isCompleted,
        ]
        if let u = r.url?.absoluteString { item["url"] = u }
        if let n = r.notes { item["notes"] = n }
        if let d = dueString(r.dueDateComponents) { item["due"] = d }
        return item
    }
    out(["exists": true, "reminders": items])
}

if payload.action == "lists" {
    let lists = store.calendars(for: .reminder).map { c -> [String: Any] in
        ["title": c.title, "source": c.source.title]
    }
    out(["lists": lists])
}

if payload.action == "delete-list" {
    guard let cal = findList(payload.listName) else { out(["deleted": false]) }
    do { try store.removeCalendar(cal, commit: true); out(["deleted": true]) }
    catch { out(["fatal": "delete-list: \(error.localizedDescription)"]) }
}

if payload.action == "apply" {
    var calendar = findList(payload.listName)
    if calendar == nil {
        let cal = EKCalendar(for: .reminder, eventStore: store)
        cal.title = payload.listName
        guard let src = store.defaultCalendarForNewReminders()?.source
            ?? store.sources.first(where: { $0.sourceType == .local })
            ?? store.sources.first else {
            out(["fatal": "create-list: no-source"])
        }
        cal.source = src
        do {
            try store.saveCalendar(cal, commit: true)
            calendar = cal
        } catch {
            out(["fatal": "create-list: \(error.localizedDescription)"])
        }
    }
    let cal = calendar!

    var created: [String: String] = [:]
    var errors: [String] = []

    for c in payload.create ?? [] {
        let r = EKReminder(eventStore: store)
        r.title = c.name
        r.calendar = cal
        if let dc = dueComponents(c.due) { r.dueDateComponents = dc }
        if let us = c.url, let u = URL(string: us) { r.url = u }
        r.notes = c.notes
        do {
            try store.save(r, commit: true)
            created[c.key] = r.calendarItemIdentifier
        } catch {
            errors.append("create: \(error.localizedDescription)")
        }
    }
    for u in payload.update ?? [] {
        guard let r = findReminder(u.id) else {
            errors.append("update-missing: \(u.id)")
            continue
        }
        r.title = u.name
        r.dueDateComponents = dueComponents(u.due)
        if let us = u.url { r.url = URL(string: us) } else { r.url = nil }
        r.notes = u.notes
        do { try store.save(r, commit: true) } catch {
            errors.append("update: \(error.localizedDescription)")
        }
    }
    for id in payload.complete ?? [] {
        guard let r = findReminder(id) else { continue }
        r.isCompleted = true
        do { try store.save(r, commit: true) } catch {
            errors.append("complete: \(error.localizedDescription)")
        }
    }
    for id in payload.delete ?? [] {
        guard let r = findReminder(id) else { continue }
        do { try store.remove(r, commit: true) } catch {
            errors.append("delete: \(error.localizedDescription)")
        }
    }
    out(["created": created, "errors": errors])
}

out(["fatal": "unknown-mode"])
