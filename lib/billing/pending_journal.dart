import 'dart:convert';
import 'dart:io';

import 'billing_controller.dart';

/// Keeps only the server-issued purchase context in app-private storage.
/// No purchase tokens, access tokens, photos or entitlement proofs are saved.
class FilePendingPurchaseJournal implements PendingPurchaseJournal {
  FilePendingPurchaseJournal(this.file);
  final File file;
  Future<void> _writes = Future<void>.value();

  Future<List<PurchaseContext>> _read() async {
    if (!await file.exists()) return [];
    final value = jsonDecode(await file.readAsString());
    if (value is! List) throw const FormatException('Invalid billing journal');
    return value.map((row) => PurchaseContext.fromJson(
        Map<String, dynamic>.from(row as Map))).toList();
  }

  @override
  Future<List<PurchaseContext>> load() async {
    await _writes;
    return _read();
  }

  Future<void> _change(void Function(List<PurchaseContext>) change) {
    final next = _writes.then((_) async {
      final contexts = await _read();
      change(contexts);
      await file.parent.create(recursive: true);
      final temporary = File('${file.path}.tmp');
      await temporary.writeAsString(
          jsonEncode(contexts.map((context) => context.toJson()).toList()),
          flush: true);
      await temporary.rename(file.path);
    });
    _writes = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  @override
  Future<void> put(PurchaseContext context) => _change((contexts) {
    contexts.removeWhere((item) => item.productId == context.productId);
    contexts.add(context);
  });

  @override
  Future<void> remove(String productId) => _change(
      (contexts) => contexts.removeWhere((item) => item.productId == productId));
}
