# פריסה ב-Render

## פריסה ראשונה דרך GitHub

1. פתח את Render והתחבר לחשבון.
2. בחר New ואז Blueprint.
3. חבר את המאגר `7166810a-gif/AAS`.
4. Render יקרא את `render.yaml` וייצור Web Service.
5. במסך Environment הוסף את `OPENAI_API_KEY` ואת `YEMOT_TOKEN`.
6. שמור והמתן לסיום ה-build וה-deploy.

## משתני סביבה

| שם | חובה | הסבר |
|---|---:|---|
| OPENAI_API_KEY | כן | מפתח API של OpenAI |
| YEMOT_TOKEN | כן | טוקן ימות בפורמט מספר מערכת:סיסמת API |
| ACCESS_KEY | כן | נוצר אוטומטית ב-Render דרך render.yaml |
| ADMIN_PASSWORD | כן | נוצר אוטומטית ב-Render דרך render.yaml |
| OPENAI_CHAT_MODEL | לא | ברירת מחדל gpt-4o-mini |
| OPENAI_TRANSCRIBE_MODEL | לא | ברירת מחדל gpt-4o-mini-transcribe |
| YEMOT_API_BASE | לא | כתובת ה-API של ימות המשיח |

## אחרי הפריסה

פתח את כתובת השירות ואת `/health`. ודא שארבעת הסעיפים ב-`configured` מסומנים true. אל תשתף את הערכים הסודיים.

את ערך `ACCESS_KEY` יש להעתיק ממסך Environment של Render אל `api_add_0=key=...` בשלוחת IVR2.

במסלול Free של Render השירות עשוי להיכנס למצב שינה לאחר חוסר פעילות ולהתעורר בפנייה הבאה. הדבר עלול להוסיף זמן המתנה למתקשר. לשימוש טלפוני רציף כדאי לבחור תוכנית שאינה נכנסת לשינה, בהתאם לתוכניות הזמינות בחשבון Render.
