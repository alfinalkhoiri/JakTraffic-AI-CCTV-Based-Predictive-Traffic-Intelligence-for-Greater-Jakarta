import 'package:flutter_test/flutter_test.dart';

import 'package:jaktraffic_mobile/main.dart';

void main() {
  testWidgets('App renders bottom navigation tabs', (WidgetTester tester) async {
    await tester.pumpWidget(const JakTrafficApp());
    await tester.pump();

    expect(find.text('Peta'), findsOneWidget);
    expect(find.text('Prediksi'), findsOneWidget);
    expect(find.text('Chat AI'), findsOneWidget);
    expect(find.text('Sinyal'), findsNothing);
  });
}
